#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from "@slack/web-api";
import type { Firestore } from "firebase-admin/firestore";
import {
  collections,
  decrypt,
  initFirebaseFromConfig,
  loadConfig,
  now,
  writeAuditLog,
} from "@hr-hermes/shared";
import type { Project } from "@hr-hermes/shared";

const service = "slack-mcp";

async function audit(
  db: Firestore,
  tool: string,
  input: unknown,
  output: unknown,
  durationMs: number,
  projectId?: string,
  threadId?: string
) {
  await writeAuditLog(db, "tool_call", {
    tool,
    input,
    output,
    durationMs,
    projectId,
    threadId,
  });
}

async function loadActiveProject(db: Firestore, projectId: string): Promise<Project> {
  const snap = await db.collection(collections.projects).doc(projectId).get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  const p = snap.data() as Project;
  if (!p.active) throw new Error(`Inactive project: ${projectId}`);
  if (!p.slack) throw new Error("project.slack is not configured");
  return p;
}

function start() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const server = new Server({ name: service, version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "post_approval_message",
        description: "Post Slack approval UI for a thread (requires project.slack).",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            threadId: { type: "string" },
            extraction: { type: "object" },
            draftedReply: { type: "string" },
            trelloCardUrl: { type: "string" },
          },
          required: ["projectId", "threadId", "extraction", "draftedReply", "trelloCardUrl"],
        },
      },
      {
        name: "update_message",
        description: "Update an existing Slack message blocks.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            channelId: { type: "string" },
            ts: { type: "string" },
            blocks: { type: "array" },
          },
          required: ["projectId", "channelId", "ts", "blocks"],
        },
      },
      {
        name: "open_modal",
        description: "Open a Slack modal (pass trigger_id and view JSON).",
        inputSchema: {
          type: "object",
          properties: {
            triggerId: { type: "string" },
            view: { type: "object" },
            projectIdHint: { type: "string" },
          },
          required: ["triggerId", "view", "projectIdHint"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t0 = Date.now();
    const name = req.params.name;
    const args = (req.params.arguments || {}) as Record<string, unknown>;
    try {
      let result: unknown;
      if (name === "post_approval_message") {
        const projectId = String(args.projectId);
        const threadId = String(args.threadId);
        const extraction = args.extraction as Record<string, unknown>;
        const draftedReply = String(args.draftedReply);
        const trelloCardUrl = String(args.trelloCardUrl);
        const project = await loadActiveProject(db, projectId);
        const token = decrypt(project.slack!.botTokenEncrypted, cfg.ENCRYPTION_KEY);
        const client = new WebClient(token);
        const value = JSON.stringify({ projectId, threadId });
        const blocks = [
          { type: "header", text: { type: "plain_text", text: "Client reply approval" } },
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Trello:* ${trelloCardUrl}` },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Extraction:*\n\`\`\`${JSON.stringify(extraction, null, 2).slice(0, 2800)}\`\`\`` },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Draft reply:*\n${draftedReply.slice(0, 2800)}` },
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
        const post = await client.chat.postMessage({
          channel: project.slack!.channelId,
          text: "Approval needed for client reply",
          blocks,
        });
        await db
          .collection(collections.emailThreads)
          .doc(threadId)
          .set(
            {
              slackMessageTs: post.ts,
              slackChannelId: project.slack!.channelId,
            },
            { merge: true }
          );
        result = { ts: post.ts, channel: project.slack!.channelId };
      } else if (name === "update_message") {
        const projectId = String(args.projectId);
        const channelId = String(args.channelId);
        const ts = String(args.ts);
        const blocks = args.blocks as unknown[];
        const project = await loadActiveProject(db, projectId);
        if (channelId !== project.slack!.channelId) {
          throw new Error("Refusing to update Slack message outside project channel");
        }
        const token = decrypt(project.slack!.botTokenEncrypted, cfg.ENCRYPTION_KEY);
        const client = new WebClient(token);
        await client.chat.update({ channel: channelId, ts, blocks: blocks as never, text: "Updated" });
        result = { ok: true };
      } else if (name === "open_modal") {
        const triggerId = String(args.triggerId);
        const view = args.view as object;
        const projectIdHint = String(args.projectIdHint || "");
        let token = "";
        if (projectIdHint) {
          const project = await loadActiveProject(db, projectIdHint);
          token = decrypt(project.slack!.botTokenEncrypted, cfg.ENCRYPTION_KEY);
        } else {
          throw new Error("open_modal requires projectIdHint until trigger routing is added");
        }
        const client = new WebClient(token);
        await client.views.open({ trigger_id: triggerId, view: view as never });
        result = { ok: true };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      const durationMs = Date.now() - t0;
      await audit(db, name, args, result, durationMs, String(args.projectId), args.threadId as string | undefined);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      const durationMs = Date.now() - t0;
      const err = e instanceof Error ? e.message : String(e);
      await audit(db, name, args, { error: err }, durationMs, String(args.projectId), args.threadId as string | undefined);
      return { content: [{ type: "text", text: JSON.stringify({ error: err }) }], isError: true };
    }
  });

  void server.connect(new StdioServerTransport());
}

start();
