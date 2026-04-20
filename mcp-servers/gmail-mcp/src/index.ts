#!/usr/bin/env node
import { createHash } from "node:crypto";
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
import { buildListQuery, extractPlainTextFromPayload, gmailClientForProject, headerMap } from "./gmail.js";

const service = "gmail-mcp";

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

function start() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const server = new Server({ name: service, version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_new_emails",
        description: "List unread messages for a project inbox, upsert threads, mark read.",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
          required: ["projectId"],
        },
      },
      {
        name: "fetch_message",
        description: "Fetch a Gmail message by id for a project.",
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
        description: "Send a reply with approval token (enforced).",
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
        try {
          const gmail = gmailClientForProject(project, cfg.ENCRYPTION_KEY);
          const q = buildListQuery(project.gmail.watchLabel);
          const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 20 });
          const ids = list.data.messages?.map((m) => m.id).filter(Boolean) as string[];
          const out: { threadId: string; summaryLine: string }[] = [];
          if (!ids?.length) {
            await db.collection(collections.projects).doc(projectId).update({
              lastPolledAt: now(),
              lastPollError: null,
              updatedAt: now(),
            });
            result = { emails: [] };
          } else {
            for (const messageId of ids) {
              const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
              const threadIdGmail = full.data.threadId || "";
              if (!threadIdGmail) continue;
              const headers = headerMap(full.data.payload?.headers);
              const from = headers["from"] || "";
              const subject = headers["subject"] || "";
              const messageIdHeader = headers["message-id"] || "";
              const date = headers["date"] || "";
              const body = extractPlainTextFromPayload(full.data.payload);
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
                clientEmail: from,
                clientName: from,
                subject,
                firstReceivedAt: prev?.firstReceivedAt || (now() as unknown as EmailThread["firstReceivedAt"]),
                lastMessageAt: now() as unknown as EmailThread["lastMessageAt"],
                rawEmail: body,
                rawEmailHistory,
                lastMessageIdHeader: messageIdHeader || prev?.lastMessageIdHeader,
                state: nextState,
                stateHistory:
                  prev?.stateHistory && prev.stateHistory.length
                    ? prev.stateHistory
                    : ([
                        {
                          state: "received",
                          at: now() as unknown as EmailThread["stateHistory"][number]["at"],
                          by: "gmail-mcp",
                          step: "list_new_emails",
                        },
                      ] as EmailThread["stateHistory"]),
              };
              await ref.set(threadDoc, { merge: true });
              await gmail.users.messages.modify({
                userId: "me",
                id: messageId,
                requestBody: { removeLabelIds: ["UNREAD"] },
              });
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
            result = { emails: out };
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await setPollError(db, projectId, msg);
          result = { emails: [], error: msg };
        }
      } else if (name === "fetch_message") {
        const projectId = String(args.projectId);
        const gmailMessageId = String(args.gmailMessageId);
        const project = await loadProject(db, projectId);
        const gmail = gmailClientForProject(project, cfg.ENCRYPTION_KEY);
        const full = await gmail.users.messages.get({ userId: "me", id: gmailMessageId, format: "full" });
        result = full.data;
      } else if (name === "send_reply") {
        const projectId = String(args.projectId);
        const threadId = String(args.threadId);
        const replyText = String(args.replyText);
        const approvalToken = String(args.approvalToken);
        const project = await loadProject(db, projectId);
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

          tx.update(tokenRef, { used: true, usedAt: now(), usedBy: "gmail-mcp" });
        });

        if (dryRunEffective) {
          await db.collection(collections.dryRunOutbox).doc(threadId).set({
            threadId,
            projectId,
            replyText,
            at: now(),
            dryRun: true,
          });
        } else {
          const gmail = gmailClientForProject(project, cfg.ENCRYPTION_KEY);
          const subjectBase = (thPre.subject || "").replace(/^\s*Re:\s*/i, "");
          const subject = `Re: ${subjectBase}`;
          const lines = [
            `From: ${project.gmail.inboxEmail}`,
            `To: ${thPre.clientEmail}`,
            `Subject: ${subject}`,
            `In-Reply-To: ${thPre.lastMessageIdHeader || ""}`,
            `References: ${thPre.lastMessageIdHeader || ""}`,
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=UTF-8",
            "",
            replyText,
          ];
          const raw = Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
          await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw, threadId: thPre.gmailThreadId },
          });
        }

        const hist = [...(thPre.stateHistory || [])];
        hist.push({ state: "sent", at: now() as never, by: "gmail-mcp", step: "send_reply" });
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
      const err = e instanceof Error ? e.message : String(e);
      await audit(db, name, args, { error: err }, durationMs, String(args.projectId), args.threadId as string | undefined);
      return { content: [{ type: "text", text: JSON.stringify({ error: err }) }], isError: true };
    }
  });

  void server.connect(new StdioServerTransport());
}

start();
