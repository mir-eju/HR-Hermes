import { randomBytes, randomUUID, createHash } from "node:crypto";
import express from "express";
import { WebClient } from "@slack/web-api";
import {
  collections,
  decrypt,
  initFirebaseFromConfig,
  loadConfig,
  now,
  telegramApi,
  Timestamp,
  writeAuditLog,
} from "@hr-hermes/shared";
import type { EmailThread, Project } from "@hr-hermes/shared";
import { verifySlackRequest } from "./slackVerify.js";

function payloadHash(threadId: string, replyText: string): string {
  return createHash("sha256").update(threadId, "utf8").update(replyText, "utf8").digest("hex");
}

function newNonce(): string {
  return randomBytes(8).toString("hex");
}

function approvalKeyboard(nonce: string) {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `apr:${nonce}` },
        { text: "Reject", callback_data: `rej:${nonce}` },
        { text: "Edit", callback_data: `edt:${nonce}` },
      ],
    ],
  };
}

function buildTelegramApprovalText(opts: {
  trelloCardUrl: string;
  extraction: unknown;
  draftedReply: string;
}): string {
  const ex = JSON.stringify(opts.extraction, null, 2).slice(0, 3500);
  const draft = opts.draftedReply.slice(0, 3500);
  return (
    `Client reply approval\n\n` +
    `Trello: ${opts.trelloCardUrl}\n\n` +
    `Extraction:\n${ex}\n\n` +
    `Draft reply:\n${draft}`
  );
}

function buildSlackApprovalBlocks(opts: {
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

function verifyTelegramSecret(
  cfg: ReturnType<typeof loadConfig>,
  req: express.Request
): void {
  const secret = cfg.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error("telegram webhook not configured");
  const got = String(req.headers["x-telegram-bot-api-secret-token"] || "");
  if (got !== secret) throw new Error("invalid telegram webhook secret");
}

async function answerTelegramCb(
  botToken: string,
  id: string,
  text?: string
): Promise<void> {
  const body: Record<string, unknown> = { callback_query_id: id };
  if (text) body.text = text.slice(0, 200);
  await telegramApi(botToken, "answerCallbackQuery", body);
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
      if (!cfg.SLACK_SIGNING_SECRET) {
        return res.status(503).send("slack signing not configured");
      }
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
          void handleSlackViewSubmission(cfg, db, payload).catch((e) => console.error(e));
          return res.status(200).json({ response_action: "clear" });
        }

        void handleSlackBlockActions(cfg, db, payload).catch((e) => console.error(e));
        return res.status(200).json({ response_type: "ephemeral", text: "✅ received, processing..." });
      }

      return res.status(415).send("unsupported content type");
    }
  );

  app.post("/telegram/webhook", express.json({ limit: "2mb" }), (req, res) => {
    try {
      verifyTelegramSecret(cfg, req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not configured")) return res.status(503).send(msg);
      return res.status(401).send("unauthorized");
    }

    const update = req.body as {
      callback_query?: {
        id: string;
        data?: string;
        from?: { id: number };
        message?: { chat?: { id: number }; message_id?: number };
      };
      message?: {
        message_id?: number;
        chat?: { id: number };
        from?: { is_bot?: boolean; id?: number };
        text?: string;
        reply_to_message?: { message_id?: number };
      };
    };

    void handleTelegramUpdate(cfg, db, update).catch((e) => console.error(e));
    return res.sendStatus(200);
  });

  app.listen(cfg.GUARDRAIL_PORT, () => {
    console.log(JSON.stringify({ service: "guardrail", port: cfg.GUARDRAIL_PORT }));
  });
}

async function handleSlackViewSubmission(
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
  if (!project.slack) return;
  const token = decrypt(project.slack.botTokenEncrypted, cfg.ENCRYPTION_KEY);
  const client = new WebClient(token);
  const extraction = th.extraction || {};
  const trello = th.trelloCardUrl || "";
  const blocks = buildSlackApprovalBlocks({
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

async function handleSlackBlockActions(
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
  if (!project.slack) return;
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

async function handleTelegramUpdate(
  cfg: ReturnType<typeof loadConfig>,
  db: ReturnType<typeof initFirebaseFromConfig>,
  update: {
    callback_query?: {
      id: string;
      data?: string;
      from?: { id: number };
      message?: { chat?: { id: number }; message_id?: number };
    };
    message?: {
      message_id?: number;
      chat?: { id: number };
      from?: { is_bot?: boolean; id?: number };
      text?: string;
      reply_to_message?: { message_id?: number };
    };
  }
) {
  if (update.callback_query) {
    await handleTelegramCallback(cfg, db, update.callback_query);
    return;
  }
  if (update.message?.text && update.message.reply_to_message?.message_id != null) {
    await handleTelegramReplyDraft(cfg, db, update.message);
  }
}

async function handleTelegramCallback(
  cfg: ReturnType<typeof loadConfig>,
  db: ReturnType<typeof initFirebaseFromConfig>,
  cq: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { chat?: { id: number }; message_id?: number };
  }
) {
  const raw = cq.data || "";
  const colon = raw.indexOf(":");
  if (colon <= 0) return;
  const kind = raw.slice(0, colon);
  const nonce = raw.slice(colon + 1);
  if (!nonce || (kind !== "apr" && kind !== "rej" && kind !== "edt")) return;

  const routeSnap = await db.collection(collections.telegramCallbackRoutes).doc(nonce).get();
  if (!routeSnap.exists) return;
  const route = routeSnap.data() as { threadId: string; projectId: string };
  const { threadId, projectId } = route;
  const threadRef = db.collection(collections.emailThreads).doc(threadId);
  const thSnap = await threadRef.get();
  if (!thSnap.exists) {
    await routeSnap.ref.delete();
    return;
  }
  const th = thSnap.data() as EmailThread;
  const projectSnap = await db.collection(collections.projects).doc(projectId).get();
  if (!projectSnap.exists) {
    await routeSnap.ref.delete();
    return;
  }
  const project = projectSnap.data() as Project;
  if (!project.telegram) {
    await routeSnap.ref.delete();
    return;
  }
  const botToken = decrypt(project.telegram.botTokenEncrypted, cfg.ENCRYPTION_KEY);
  const userId = cq.from?.id != null ? String(cq.from.id) : "unknown";

  try {
    if (kind === "apr") {
      const replyText = th.editedReply || th.draftedReply || "";
      if (!replyText) {
        await answerTelegramCb(botToken, cq.id, "No draft reply on thread.");
        await routeSnap.ref.delete();
        return;
      }
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
      if (th.telegramChatId && th.telegramMessageId) {
        await telegramApi(botToken, "editMessageText", {
          chat_id: th.telegramChatId,
          message_id: Number(th.telegramMessageId),
          text: `Approved by user ${userId} — sending…`,
          reply_markup: { inline_keyboard: [] },
        });
      }
      await routeSnap.ref.delete();
      await answerTelegramCb(botToken, cq.id);
      return;
    }

    if (kind === "rej") {
      await db.collection(collections.approvalSignals).doc(threadId).set({
        projectId,
        threadId,
        action: "rejected",
        userId,
        at: now(),
        consumed: false,
      });
      await threadRef.set({ state: "rejected" }, { merge: true });
      if (th.telegramChatId && th.telegramMessageId) {
        await telegramApi(botToken, "editMessageText", {
          chat_id: th.telegramChatId,
          message_id: Number(th.telegramMessageId),
          text: `Rejected by user ${userId}`,
          reply_markup: { inline_keyboard: [] },
        });
      }
      await routeSnap.ref.delete();
      await answerTelegramCb(botToken, cq.id);
      return;
    }

    if (kind === "edt") {
      await threadRef.set({ awaitingTelegramEdit: true }, { merge: true });
      await db.collection(collections.approvalSignals).doc(threadId).set({
        projectId,
        threadId,
        action: "edit_reply",
        userId,
        at: now(),
        consumed: false,
      });
      await answerTelegramCb(
        botToken,
        cq.id,
        "Reply to the approval message with your full replacement draft."
      );
      await routeSnap.ref.delete();
    }
  } catch (e) {
    console.error(e);
    try {
      await answerTelegramCb(botToken, cq.id, e instanceof Error ? e.message : "Error");
    } catch {
      /* ignore */
    }
  }
}

async function handleTelegramReplyDraft(
  cfg: ReturnType<typeof loadConfig>,
  db: ReturnType<typeof initFirebaseFromConfig>,
  message: {
    message_id?: number;
    chat?: { id: number };
    from?: { is_bot?: boolean; id?: number };
    text?: string;
    reply_to_message?: { message_id?: number };
  }
) {
  if (message.from?.is_bot) return;
  const text = (message.text || "").trim();
  if (!text) return;
  const chatId = message.chat?.id;
  const replyToId = message.reply_to_message?.message_id;
  if (chatId == null || replyToId == null) return;

  const qs = await db
    .collection(collections.emailThreads)
    .where("telegramChatId", "==", String(chatId))
    .where("telegramMessageId", "==", String(replyToId))
    .where("awaitingTelegramEdit", "==", true)
    .limit(1)
    .get();
  if (qs.empty) return;

  const doc = qs.docs[0];
  const th = doc.data() as EmailThread;
  const projectId = th.projectId;
  const projectSnap = await db.collection(collections.projects).doc(projectId).get();
  if (!projectSnap.exists) return;
  const project = projectSnap.data() as Project;
  if (!project.telegram) return;
  const botToken = decrypt(project.telegram.botTokenEncrypted, cfg.ENCRYPTION_KEY);
  const before = th.draftedReply || "";

  await doc.ref.set(
    {
      editedReply: text,
      awaitingTelegramEdit: false,
      humanEdits: {
        ...(th.humanEdits || {}),
        replyBefore: before,
        replyAfter: text,
      },
    },
    { merge: true }
  );

  const nonce = newNonce();
  await db
    .collection(collections.telegramCallbackRoutes)
    .doc(nonce)
    .set({ threadId: doc.id, projectId, createdAt: now() });

  const th2 = { ...th, editedReply: text };
  const body = buildTelegramApprovalText({
    trelloCardUrl: th2.trelloCardUrl || "",
    extraction: th2.extraction || {},
    draftedReply: text,
  });

  await telegramApi(botToken, "editMessageText", {
    chat_id: th.telegramChatId,
    message_id: Number(th.telegramMessageId),
    text: body,
    reply_markup: approvalKeyboard(nonce),
  });

  await db.collection(collections.approvalSignals).doc(doc.id).set({
    projectId,
    threadId: doc.id,
    action: "edited",
    userId: message.from?.id != null ? String(message.from.id) : "telegram",
    at: now(),
    consumed: false,
  });
}

void main();
