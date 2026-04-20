import { randomUUID, createHash } from "node:crypto";
import express from "express";
import { WebClient } from "@slack/web-api";
import {
  collections,
  decrypt,
  initFirebaseFromConfig,
  loadConfig,
  now,
  Timestamp,
  writeAuditLog,
} from "@hr-hermes/shared";
import type { EmailThread, Project } from "@hr-hermes/shared";
import { verifySlackRequest } from "./slackVerify.js";

function payloadHash(threadId: string, replyText: string): string {
  return createHash("sha256").update(threadId, "utf8").update(replyText, "utf8").digest("hex");
}

function buildApprovalBlocks(opts: {
  projectId: string;
  threadId: string;
  extraction: unknown;
  draftedReply: string;
  trelloCardUrl: string;
}) {
  const value = JSON.stringify({ projectId: opts.projectId, threadId: opts.threadId });
  return [
    { type: "header", text: { type: "plain_text", text: "Client reply approval" } },
    { type: "section", text: { type: "mrkdwn", text: `*Trello:* ${opts.trelloCardUrl}` } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Extraction:*\n\`\`\`${JSON.stringify(opts.extraction, null, 2).slice(0, 2800)}\`\`\``,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Draft reply:*\n${opts.draftedReply.slice(0, 2800)}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "approve_reply",
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Edit" },
          action_id: "edit_reply",
          value,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "reject_reply",
          value,
        },
      ],
    },
  ];
}

async function main() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const app = express();

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post(
    "/slack/events",
    express.raw({ type: () => true, limit: "2mb" }),
    (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body as ArrayBuffer);
      const ctype = String(req.headers["content-type"] || "");

      try {
        verifySlackRequest({
          signingSecret: cfg.SLACK_SIGNING_SECRET,
          requestTimestamp: String(req.headers["x-slack-request-timestamp"] || ""),
          signature: String(req.headers["x-slack-signature"] || ""),
          rawBody,
        });
      } catch {
        return res.status(401).send("invalid signature");
      }

      if (ctype.includes("application/json")) {
        const json = JSON.parse(rawBody.toString("utf8")) as { type?: string; challenge?: string };
        if (json?.type === "url_verification" && json.challenge) {
          return res.status(200).type("text/plain").send(json.challenge);
        }
        return res.sendStatus(200);
      }

      if (ctype.includes("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams(rawBody.toString("utf8"));
        const payload = JSON.parse(params.get("payload") || "{}") as {
          type?: string;
          actions?: { action_id?: string; value?: string }[];
          user?: { id?: string };
          trigger_id?: string;
          view?: {
            callback_id?: string;
            private_metadata?: string;
            state?: { values?: Record<string, Record<string, { value?: string }>> };
          };
        };

        if (payload.type === "view_submission" && payload.view?.callback_id === "hermes_edit_reply") {
          void handleViewSubmission(cfg, db, payload).catch((e) => console.error(e));
          return res.status(200).json({ response_action: "clear" });
        }

        void handleBlockActions(cfg, db, payload).catch((e) => console.error(e));
        return res.status(200).json({ response_type: "ephemeral", text: "✅ received, processing..." });
      }

      return res.status(415).send("unsupported content type");
    }
  );

  app.listen(cfg.GUARDRAIL_PORT, () => {
    console.log(JSON.stringify({ service: "guardrail", port: cfg.GUARDRAIL_PORT }));
  });
}

async function handleViewSubmission(
  cfg: ReturnType<typeof loadConfig>,
  db: ReturnType<typeof initFirebaseFromConfig>,
  payload: {
    view?: {
      callback_id?: string;
      private_metadata?: string;
      state?: { values?: Record<string, Record<string, { value?: string }>> };
    };
  }
) {
  const meta = JSON.parse(payload.view?.private_metadata || "{}") as { projectId: string; threadId: string };
  const draft =
    payload.view?.state?.values?.reply_block?.reply_input?.value ||
    payload.view?.state?.values?.reply_block?.plain_text?.value ||
    "";
  const threadRef = db.collection(collections.emailThreads).doc(meta.threadId);
  const snap = await threadRef.get();
  if (!snap.exists) return;
  const th = snap.data() as EmailThread;
  const before = th.draftedReply || "";
  await threadRef.set(
    {
      editedReply: draft,
      humanEdits: {
        ...(th.humanEdits || {}),
        replyBefore: before,
        replyAfter: draft,
      },
    },
    { merge: true }
  );
  const projectSnap = await db.collection(collections.projects).doc(meta.projectId).get();
  const project = projectSnap.data() as Project;
  const token = decrypt(project.slack.botTokenEncrypted, cfg.ENCRYPTION_KEY);
  const client = new WebClient(token);
  const extraction = th.extraction || {};
  const trello = th.trelloCardUrl || "";
  const blocks = buildApprovalBlocks({
    projectId: meta.projectId,
    threadId: meta.threadId,
    extraction,
    draftedReply: draft,
    trelloCardUrl: trello,
  });
  await client.chat.postMessage({
    channel: project.slack.channelId,
    text: "Updated approval request",
    blocks,
  });
  await db.collection(collections.approvalSignals).doc(meta.threadId).set({
    projectId: meta.projectId,
    threadId: meta.threadId,
    action: "edited",
    userId: "slack",
    at: now(),
    consumed: false,
  });
}

async function handleBlockActions(
  cfg: ReturnType<typeof loadConfig>,
  db: ReturnType<typeof initFirebaseFromConfig>,
  payload: {
    type?: string;
    actions?: { action_id?: string; value?: string }[];
    user?: { id?: string };
    trigger_id?: string;
  }
) {
  const action = payload.actions?.[0];
  if (!action?.value || !action.action_id) return;
  const { projectId, threadId } = JSON.parse(action.value) as { projectId: string; threadId: string };
  const userId = payload.user?.id || "unknown";
  const threadRef = db.collection(collections.emailThreads).doc(threadId);
  const thSnap = await threadRef.get();
  if (!thSnap.exists) return;
  const th = thSnap.data() as EmailThread;
  const projectSnap = await db.collection(collections.projects).doc(projectId).get();
  const project = projectSnap.data() as Project;
  const slackToken = decrypt(project.slack.botTokenEncrypted, cfg.ENCRYPTION_KEY);
  const client = new WebClient(slackToken);

  if (action.action_id === "approve_reply") {
    const replyText = th.editedReply || th.draftedReply || "";
    if (!replyText) return;
    const tokenId = randomUUID();
    const hash = payloadHash(threadId, replyText);
    await db
      .collection(collections.approvalTokens)
      .doc(tokenId)
      .set({
        id: tokenId,
        threadId,
        projectId,
        kind: "send_reply",
        payloadHash: hash,
        issuedAt: now(),
        expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
        used: false,
        issuedBy: userId,
      });
    await writeAuditLog(db, "approval_issued", {
      projectId,
      threadId,
      tool: "guardrail",
      input: { tokenId },
    });
    await db.collection(collections.approvalSignals).doc(threadId).set({
      projectId,
      threadId,
      action: "approved",
      tokenId,
      userId,
      at: now(),
      consumed: false,
    });
    if (th.slackChannelId && th.slackMessageTs) {
      await client.chat.update({
        channel: th.slackChannelId,
        ts: th.slackMessageTs,
        text: `✅ Approved by <@${userId}> — sending...`,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `✅ Approved by <@${userId}> — sending...` },
          },
        ],
      });
    }
    return;
  }

  if (action.action_id === "reject_reply") {
    await db.collection(collections.approvalSignals).doc(threadId).set({
      projectId,
      threadId,
      action: "rejected",
      userId,
      at: now(),
      consumed: false,
    });
    await threadRef.set({ state: "rejected" }, { merge: true });
    if (th.slackChannelId && th.slackMessageTs) {
      await client.chat.update({
        channel: th.slackChannelId,
        ts: th.slackMessageTs,
        text: `❌ Rejected by <@${userId}>`,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `❌ Rejected by <@${userId}>` } }],
      });
    }
    return;
  }

  if (action.action_id === "edit_reply" && payload.trigger_id) {
    await client.views.open({
      trigger_id: payload.trigger_id,
      view: {
        type: "modal",
        callback_id: "hermes_edit_reply",
        private_metadata: JSON.stringify({ projectId, threadId }),
        title: { type: "plain_text", text: "Edit reply" },
        submit: { type: "plain_text", text: "Save" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "reply_block",
            label: { type: "plain_text", text: "Reply" },
            element: {
              type: "plain_text_input",
              action_id: "reply_input",
              multiline: true,
              initial_value: th.draftedReply || "",
            },
          },
        ],
      },
    });
    await db.collection(collections.approvalSignals).doc(threadId).set({
      projectId,
      threadId,
      action: "edit_reply",
      userId,
      at: now(),
      consumed: false,
    });
  }
}

void main();
