#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Composio } from "@composio/core";
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
  makeThreadId,
  now,
  writeAuditLog,
} from "@hr-hermes/shared";
import type { ApprovalToken, EmailThread, Project } from "@hr-hermes/shared";
import {
  buildListQuery,
  extractEmailFromFromHeader,
  extractPlainTextFromPayload,
  formatComposioExecutionError,
  headerMap,
  normalizeMessages,
  peekComposioListPayload,
  responseShapeHint,
  unwrapComposioData,
} from "./helpers.js";

const service = "composio-gmail-mcp";

let composioClient: Composio | null = null;

function requireComposioKey(): string {
  const k = process.env.COMPOSIO_API_KEY || "";
  if (!k) throw new Error("COMPOSIO_API_KEY is required for Composio Gmail MCP");
  return k;
}

function getComposio(): Composio {
  if (!composioClient) composioClient = new Composio({ apiKey: requireComposioKey() });
  return composioClient;
}

function composioExecuteOpts(project: Project): { userId: string; connectedAccountId?: string } {
  const userId = project.gmail.composioUserId;
  const ca = project.gmail.composioConnectedAccountId;
  const connectedAccountId =
    typeof ca === "string" && ca.trim() ? ca.trim() : undefined;
  return connectedAccountId ? { userId, connectedAccountId } : { userId };
}

async function executeTool(
  slug: string,
  arguments_: Record<string, unknown>,
  project: Project
): Promise<unknown> {
  const c = getComposio();
  const { userId, connectedAccountId } = composioExecuteOpts(project);
  const result = await c.tools.execute(slug, {
    userId,
    ...(connectedAccountId ? { connectedAccountId } : {}),
    dangerouslySkipVersionCheck: true,
    arguments: arguments_,
  });
  return result;
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

function payloadHash(threadId: string, replyText: string): string {
  return createHash("sha256").update(threadId, "utf8").update(replyText, "utf8").digest("hex");
}

async function loadProject(db: Firestore, projectId: string): Promise<Project> {
  const snap = await db.collection(collections.projects).doc(projectId).get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  const p = snap.data() as Project;
  if (!p.active) throw new Error(`Inactive project: ${projectId}`);
  return p;
}

async function setPollError(db: Firestore, projectId: string, message: string) {
  await db.collection(collections.projects).doc(projectId).update({
    lastPollError: message,
    updatedAt: now(),
  });
}

function pickMessageId(m: Record<string, unknown>): string {
  const nested = m.message;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const msg = nested as Record<string, unknown>;
    const id = msg.id ?? msg.messageId ?? msg.message_id;
    if (id) return String(id);
  }
  return String(m.messageId ?? m.id ?? m.message_id ?? "");
}

function pickThreadId(m: Record<string, unknown>): string {
  const nested = m.message;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const msg = nested as Record<string, unknown>;
    const tid = msg.threadId ?? msg.thread_id;
    if (tid) return String(tid);
  }
  return String(m.threadId ?? m.thread_id ?? "");
}

function start() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const server = new Server({ name: service, version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_new_emails",
        description:
          "List unread messages via Composio Gmail, upsert Firestore threads, mark read (remove UNREAD label).",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
          required: ["projectId"],
        },
      },
      {
        name: "fetch_message",
        description: "Fetch a Gmail message by id via Composio (GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID).",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            gmailMessageId: { type: "string" },
          },
          required: ["projectId", "gmailMessageId"],
        },
      },
      {
        name: "send_reply",
        description: "Send in-thread reply via Composio (GMAIL_REPLY_TO_THREAD) with approval token gate.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            threadId: { type: "string" },
            replyText: { type: "string" },
            approvalToken: { type: "string" },
          },
          required: ["projectId", "threadId", "replyText", "approvalToken"],
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
      if (name === "list_new_emails") {
        const projectId = String(args.projectId);
        let project: Project;
        try {
          project = await loadProject(db, projectId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await setPollError(db, projectId, msg);
          result = { emails: [], error: msg };
          await audit(db, name, args, result, Date.now() - t0, projectId);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (!project.gmail.composioUserId?.trim()) {
          const msg = "project.gmail.composioUserId is missing";
          await setPollError(db, projectId, msg);
          result = { emails: [], error: msg };
          await audit(db, name, args, result, Date.now() - t0, projectId);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        try {
          requireComposioKey();
          const q = buildListQuery(project.gmail.watchLabel);
          const raw = await executeTool("GMAIL_FETCH_EMAILS", {
            query: q,
            user_id: "me",
            max_results: 20,
            verbose: true,
            include_payload: true,
          }, project);
          const messages = normalizeMessages(raw);
          const out: { threadId: string; summaryLine: string }[] = [];
          const polledMeta = {
            polledQuery: q,
            unreadScope: (process.env.GMAIL_LIST_UNREAD_SCOPE || "rolling1d").trim(),
            ...responseShapeHint(peekComposioListPayload(raw)),
          };
          if (!messages.length) {
            await db.collection(collections.projects).doc(projectId).update({
              lastPolledAt: now(),
              lastPollError: null,
              updatedAt: now(),
            });
            result = { emails: [], ...polledMeta };
          } else {
            for (const m of messages) {
              const messageId = pickMessageId(m);
              const threadIdGmail = pickThreadId(m);
              if (!messageId || !threadIdGmail) continue;
              let headers: Record<string, string> = {};
              let body = "";
              const payload = m.payload ?? m.messagePayload ?? m.mimePayload;
              if (payload && typeof payload === "object") {
                headers = headerMap((payload as { headers?: { name?: string; value?: string }[] }).headers);
                body = extractPlainTextFromPayload(payload);
              }
              const from = headers["from"] || String(m.from ?? "");
              const clientAddr = extractEmailFromFromHeader(from) || from;
              const subject = headers["subject"] || String(m.subject ?? "");
              const messageIdHeader = headers["message-id"] || "";
              const docId = makeThreadId(projectId, threadIdGmail);
              const ref = db.collection(collections.emailThreads).doc(docId);
              const snap = await ref.get();
              const prev = snap.exists ? (snap.data() as EmailThread) : undefined;
              const rawEmailHistory = [...(prev?.rawEmailHistory || [])];
              rawEmailHistory.push(body);
              const nextState =
                prev?.state && prev.state !== "received" ? prev.state : ("received" as const);
              const threadDoc: Partial<EmailThread> = {
                id: docId,
                teamId: project.teamId,
                projectId,
                gmailThreadId: threadIdGmail,
                clientEmail: clientAddr,
                clientName: from,
                subject,
                firstReceivedAt: prev?.firstReceivedAt || now(),
                lastMessageAt: now(),
                rawEmail: body,
                rawEmailHistory,
                lastMessageIdHeader: messageIdHeader || prev?.lastMessageIdHeader,
                state: nextState,
                stateHistory:
                  prev?.stateHistory && prev.stateHistory.length
                    ? prev.stateHistory
                    : [
                        {
                          state: "received",
                          at: now(),
                          by: "composio-gmail-mcp",
                          step: "list_new_emails",
                        },
                      ],
              };
              await ref.set(threadDoc, { merge: true });
              await executeTool("GMAIL_ADD_LABEL_TO_EMAIL", {
                message_id: messageId,
                user_id: "me",
                remove_label_ids: ["UNREAD"],
              }, project);
              out.push({
                threadId: docId,
                summaryLine: `${subject} — ${from}`.slice(0, 500),
              });
            }
            await db.collection(collections.projects).doc(projectId).update({
              lastPolledAt: now(),
              lastPollError: null,
              updatedAt: now(),
            });
            result =
              out.length > 0
                ? { emails: out }
                : {
                    emails: [],
                    ...polledMeta,
                    hint: "Parsed messages from Gmail but skipped all (missing message id or thread id).",
                  };
          }
        } catch (e) {
          const msg = formatComposioExecutionError(e);
          await setPollError(db, projectId, msg);
          result = { emails: [], error: msg };
        }
      } else if (name === "fetch_message") {
        const projectId = String(args.projectId);
        const gmailMessageId = String(args.gmailMessageId);
        const project = await loadProject(db, projectId);
        if (!project.gmail.composioUserId?.trim()) throw new Error("project.gmail.composioUserId is missing");
        requireComposioKey();
        const raw = await executeTool("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
          message_id: gmailMessageId,
          user_id: "me",
          format: "full",
        }, project);
        result = unwrapComposioData(raw);
      } else if (name === "send_reply") {
        const projectId = String(args.projectId);
        const threadId = String(args.threadId);
        const replyText = String(args.replyText);
        const approvalToken = String(args.approvalToken);
        const project = await loadProject(db, projectId);
        if (!project.gmail.composioUserId?.trim()) throw new Error("project.gmail.composioUserId is missing");
        const threadRef = db.collection(collections.emailThreads).doc(threadId);
        const tokenRef = db.collection(collections.approvalTokens).doc(approvalToken);
        const dryRun = cfg.dryRun || project.dryRun === true;
        const runtime = await db
          .collection("_config")
          .doc("runtime")
          .get()
          .then((s) => s.data() as { dryRun?: boolean } | undefined);
        const dryRunEffective = dryRun || runtime?.dryRun === true;

        const thSnapPre = await threadRef.get();
        if (!thSnapPre.exists) throw new Error("Unknown thread");
        const thPre = thSnapPre.data() as EmailThread;

        await db.runTransaction(async (tx) => {
          const tokSnap = await tx.get(tokenRef);
          if (!tokSnap.exists) throw new Error("approval: token not found");
          const tok = tokSnap.data() as ApprovalToken;
          if (tok.used) throw new Error("approval: token already used");
          const exp = tok.expiresAt as { toMillis?: () => number; _seconds?: number };
          const expMs =
            typeof exp?.toMillis === "function"
              ? exp.toMillis()
              : typeof exp?._seconds === "number"
                ? exp._seconds * 1000
                : Date.now() + 1;
          if (expMs < Date.now()) throw new Error("approval: token expired");
          if (tok.threadId !== threadId) throw new Error("approval: thread mismatch");
          if (tok.projectId !== projectId) throw new Error("approval: project mismatch");
          if (tok.kind !== "send_reply") throw new Error("approval: kind mismatch");
          if (tok.payloadHash !== payloadHash(threadId, replyText)) {
            throw new Error("approval: payloadHash mismatch");
          }
          tx.update(tokenRef, { used: true, usedAt: now(), usedBy: "composio-gmail-mcp" });
        });

        requireComposioKey();
        if (dryRunEffective) {
          await db.collection(collections.dryRunOutbox).doc(threadId).set({
            threadId,
            projectId,
            replyText,
            at: now(),
            dryRun: true,
          });
        } else {
          const to = extractEmailFromFromHeader(thPre.clientEmail || "");
          await executeTool("GMAIL_REPLY_TO_THREAD", {
            thread_id: thPre.gmailThreadId,
            message_body: replyText,
            recipient_email: to,
            user_id: "me",
          }, project);
        }

        const hist = [...(thPre.stateHistory || [])];
        hist.push({ state: "sent", at: now(), by: "composio-gmail-mcp", step: "send_reply" });
        await threadRef.set(
          {
            state: "sent",
            sentReply: replyText,
            stateHistory: hist,
          },
          { merge: true }
        );

        await writeAuditLog(db, "approval_consumed", {
          tool: "send_reply",
          projectId,
          threadId,
          dryRun: dryRunEffective,
        });

        const th = thPre;
        if (th.trelloCardId) {
          const trelloKey = decrypt(project.trello.apiKeyEncrypted, cfg.ENCRYPTION_KEY);
          const trelloToken = decrypt(project.trello.tokenEncrypted, cfg.ENCRYPTION_KEY);
          const comment = `Reply sent to client on ${new Date().toISOString().slice(0, 10)}`;
          const url = `https://api.trello.com/1/cards/${th.trelloCardId}/actions/comments?key=${encodeURIComponent(
            trelloKey
          )}&token=${encodeURIComponent(trelloToken)}`;
          await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: comment }),
          });
        }

        result = { ok: true, dryRun: dryRunEffective };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      const durationMs = Date.now() - t0;
      await audit(db, name, args, result, durationMs, String(args.projectId), args.threadId as string | undefined);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      const durationMs = Date.now() - t0;
      const err = formatComposioExecutionError(e);
      await audit(db, name, args, { error: err }, durationMs, String(args.projectId), args.threadId as string | undefined);
      return { content: [{ type: "text", text: JSON.stringify({ error: err }) }], isError: true };
    }
  });

  void server.connect(new StdioServerTransport());
}

start();
