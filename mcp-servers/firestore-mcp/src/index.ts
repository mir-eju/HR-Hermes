#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Firestore } from "firebase-admin/firestore";
import {
  collections,
  initFirebaseFromConfig,
  loadConfig,
  now,
  parseThreadId,
  redactProject,
  writeAuditLog,
} from "@hr-hermes/shared";
import type { EmailThread, Project, ThreadState } from "@hr-hermes/shared";

const service = "firestore-mcp";

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

async function getActiveProject(db: Firestore, projectId: string): Promise<Project> {
  const snap = await db.collection(collections.projects).doc(projectId).get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  const p = snap.data() as Project;
  if (!p.active) throw new Error(`Inactive project: ${projectId}`);
  return p;
}

async function getExistingProject(db: Firestore, projectId: string): Promise<Project> {
  const snap = await db.collection(collections.projects).doc(projectId).get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  return snap.data() as Project;
}

function start() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const server = new Server({ name: service, version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_project",
        description: "Load project metadata with secrets redacted.",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
          required: ["projectId"],
        },
      },
      {
        name: "list_active_projects",
        description: "List all active projects (metadata only, secrets redacted).",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_thread",
        description: "Load an email thread document by id.",
        inputSchema: {
          type: "object",
          properties: { threadId: { type: "string" } },
          required: ["threadId"],
        },
      },
      {
        name: "list_threads_by_state",
        description: "List threads for a project in a given state.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            state: { type: "string" },
          },
          required: ["projectId", "state"],
        },
      },
      {
        name: "update_thread",
        description:
          "Patch a thread. Refuses state=sent, cross-project projectId changes, and optional expectedState mismatch.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            patch: { type: "object" },
            expectedState: { type: "string" },
            by: { type: "string" },
            step: { type: "string" },
          },
          required: ["threadId", "patch"],
        },
      },
      {
        name: "append_error",
        description: "Append an error entry to a thread.",
        inputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            step: { type: "string" },
            message: { type: "string" },
          },
          required: ["threadId", "step", "message"],
        },
      },
      {
        name: "log_audit",
        description: "Append-only audit log entry (for hooks and tools).",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string" },
            payload: { type: "object" },
          },
          required: ["kind", "payload"],
        },
      },
      {
        name: "list_approval_signals",
        description: "List unconsumed approval signals for a project (Telegram-driven guardrail).",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
          required: ["projectId"],
        },
      },
      {
        name: "delete_approval_signal",
        description: "Delete an approval signal after processing (doc id is threadId).",
        inputSchema: {
          type: "object",
          properties: { threadId: { type: "string" } },
          required: ["threadId"],
        },
      },
      {
        name: "enqueue_skill_review",
        description: "Queue a skill edit for human review (learning loop).",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            skillFile: { type: "string" },
            diff: { type: "string" },
            previousContent: { type: "string" },
          },
          required: ["projectId", "skillFile", "diff", "previousContent"],
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
      if (name === "get_project") {
        const projectId = String(args.projectId);
        const p = await getExistingProject(db, projectId);
        result = redactProject(p);
      } else if (name === "list_active_projects") {
        const qs = await db.collection(collections.projects).where("active", "==", true).get();
        result = qs.docs.map((d) => redactProject(d.data() as Project));
      } else if (name === "get_thread") {
        const threadId = String(args.threadId);
        const snap = await db.collection(collections.emailThreads).doc(threadId).get();
        if (!snap.exists) throw new Error(`Unknown thread: ${threadId}`);
        result = snap.data();
      } else if (name === "list_threads_by_state") {
        const projectId = String(args.projectId);
        const state = String(args.state) as ThreadState;
        await getActiveProject(db, projectId);
        const qs = await db
          .collection(collections.emailThreads)
          .where("projectId", "==", projectId)
          .where("state", "==", state)
          .get();
        result = qs.docs.map((d) => d.data());
      } else if (name === "update_thread") {
        const threadId = String(args.threadId);
        const patch = { ...(args.patch as Record<string, unknown>) };
        delete patch.stateHistory;
        delete patch.errors;
        delete patch.id;
        delete patch.teamId;
        delete patch.gmailThreadId;
        const expectedState = args.expectedState as string | undefined;
        const by = String(args.by || "hermes");
        const step = String(args.step || "update_thread");

        const ref = db.collection(collections.emailThreads).doc(threadId);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) throw new Error(`Unknown thread: ${threadId}`);
          const cur = snap.data() as EmailThread;

          if (patch.state === "sent") {
            throw new Error("Refusing to set state to sent via update_thread (internal send path only)");
          }
          if (patch.projectId !== undefined && patch.projectId !== cur.projectId) {
            throw new Error("Refusing to change projectId on thread");
          }
          const { projectId: prefixProject } = parseThreadId(threadId);
          if (prefixProject !== cur.projectId) {
            throw new Error("threadId prefix does not match stored projectId");
          }
          if (expectedState && cur.state !== expectedState) {
            throw new Error(`Optimistic concurrency failure: expected ${expectedState}, got ${cur.state}`);
          }
          await getActiveProject(db, cur.projectId);

          const nextState = patch.state as ThreadState | undefined;
          const updates: Record<string, unknown> = { ...patch, updatedAt: now() };
          if (nextState && nextState !== cur.state) {
            const hist = [...(cur.stateHistory || [])];
            hist.push({
              state: nextState,
              at: now(),
              by,
              step,
            });
            updates.stateHistory = hist;
          }
          tx.set(ref, updates, { merge: true });
        });
        result = { ok: true };
      } else if (name === "append_error") {
        const threadId = String(args.threadId);
        const step = String(args.step);
        const message = String(args.message);
        const ref = db.collection(collections.emailThreads).doc(threadId);
        const snap = await ref.get();
        if (!snap.exists) throw new Error(`Unknown thread: ${threadId}`);
        const cur = snap.data() as EmailThread;
        await getActiveProject(db, cur.projectId);
        const errors = [...(cur.errors || [])];
        errors.push({ at: now(), step, message });
        await ref.update({ errors });
        result = { ok: true };
      } else if (name === "log_audit") {
        const kind = String(args.kind) as "tool_call" | "hook" | "skill_update" | "approval_issued" | "approval_consumed";
        const payload = (args.payload || {}) as Record<string, unknown>;
        const id = await writeAuditLog(db, kind, payload);
        result = { id };
      } else if (name === "list_approval_signals") {
        const projectId = String(args.projectId);
        await getActiveProject(db, projectId);
        const qs = await db
          .collection(collections.approvalSignals)
          .where("projectId", "==", projectId)
          .where("consumed", "==", false)
          .limit(50)
          .get();
        result = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      } else if (name === "delete_approval_signal") {
        const threadId = String(args.threadId);
        const { projectId } = parseThreadId(threadId);
        await getActiveProject(db, projectId);
        await db.collection(collections.approvalSignals).doc(threadId).delete();
        result = { ok: true };
      } else if (name === "enqueue_skill_review") {
        const projectId = String(args.projectId);
        await getActiveProject(db, projectId);
        const ref = db.collection(collections.skillReviewQueue).doc();
        await ref.set({
          id: ref.id,
          projectId,
          skillFile: String(args.skillFile),
          diff: String(args.diff),
          previousContent: String(args.previousContent),
          addedAt: now(),
          status: "pending",
        });
        result = { id: ref.id };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      const durationMs = Date.now() - t0;
      const threadId =
        typeof args.threadId === "string"
          ? args.threadId
          : name === "update_thread" || name === "append_error"
            ? String(args.threadId)
            : undefined;
      const projectId =
        typeof args.projectId === "string"
          ? String(args.projectId)
          : threadId
            ? parseThreadId(threadId).projectId
            : name === "get_project" || name === "list_approval_signals" || name === "enqueue_skill_review"
              ? String(args.projectId)
              : undefined;
      await audit(db, name, args, result, durationMs, projectId, threadId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      const durationMs = Date.now() - t0;
      const err = e instanceof Error ? e.message : String(e);
      await audit(db, name, args, { error: err }, durationMs);
      return { content: [{ type: "text", text: JSON.stringify({ error: err }) }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  void server.connect(transport);
}

start();
