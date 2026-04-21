#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Firestore } from "firebase-admin/firestore";
import {
  collections,
  decrypt,
  initFirebaseFromConfig,
  loadConfig,
  now,
  telegramApi,
  writeAuditLog,
} from "@hr-hermes/shared";
import type { Project } from "@hr-hermes/shared";

const service = "telegram-mcp";

function newCallbackNonce(): string {
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

function buildApprovalText(opts: {
  trelloCardUrl: string;
  extraction: Record<string, unknown>;
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

async function loadActiveProject(db: Firestore, projectId: string): Promise<Project & { telegram: NonNullable<Project["telegram"]> }> {
  const snap = await db.collection(collections.projects).doc(projectId).get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  const p = snap.data() as Project;
  if (!p.active) throw new Error(`Inactive project: ${projectId}`);
  if (!p.telegram) throw new Error("project.telegram is not configured");
  return p as Project & { telegram: NonNullable<Project["telegram"]> };
}

function start() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const server = new Server({ name: service, version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "post_approval_message",
        description: "Post Telegram approval message with Approve / Reject / Edit buttons for a thread.",
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
        const token = decrypt(project.telegram.botTokenEncrypted, cfg.ENCRYPTION_KEY);
        const chatId = project.telegram.chatId;
        const nonce = newCallbackNonce();
        await db
          .collection(collections.telegramCallbackRoutes)
          .doc(nonce)
          .set({ threadId, projectId, createdAt: now() });

        const text = buildApprovalText({ trelloCardUrl, extraction, draftedReply });
        const sent = (await telegramApi(token, "sendMessage", {
          chat_id: chatId,
          text,
          reply_markup: approvalKeyboard(nonce),
        })) as { message_id: number };

        const mid = String(sent.message_id);
        await db.collection(collections.emailThreads).doc(threadId).set(
          {
            telegramMessageId: mid,
            telegramChatId: String(chatId),
            awaitingTelegramEdit: false,
          },
          { merge: true }
        );
        result = { messageId: mid, chatId: String(chatId), nonce };
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
