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
  decrypt,
  initFirebaseFromConfig,
  loadConfig,
  writeAuditLog,
} from "@hr-hermes/shared";
import type { Project } from "@hr-hermes/shared";

const service = "trello-mcp";

async function audit(
  db: Firestore,
  tool: string,
  input: unknown,
  output: unknown,
  durationMs: number,
  projectId?: string
) {
  await writeAuditLog(db, "tool_call", {
    tool,
    input,
    output,
    durationMs,
    projectId,
  });
}

async function loadActiveProject(db: Firestore, projectId: string): Promise<Project> {
  const snap = await db.collection(collections.projects).doc(projectId).get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  const p = snap.data() as Project;
  if (!p.active) throw new Error(`Inactive project: ${projectId}`);
  return p;
}

function trelloUrl(path: string, key: string, token: string) {
  const qs = new URLSearchParams({ key, token });
  return `https://api.trello.com${path}?${qs.toString()}`;
}

function start() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const server = new Server({ name: service, version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "create_card",
        description: "Create a Trello card in the project inbox list with optional checklist.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            checklist: { type: "array", items: { type: "string" } },
          },
          required: ["projectId", "title", "description"],
        },
      },
      {
        name: "add_card_comment",
        description: "Add a comment to a Trello card.",
        inputSchema: {
          type: "object",
          properties: { cardId: { type: "string" }, text: { type: "string" } },
          required: ["cardId", "text"],
        },
      },
      {
        name: "get_card",
        description: "Fetch a Trello card by id.",
        inputSchema: {
          type: "object",
          properties: { cardId: { type: "string" } },
          required: ["cardId"],
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
      if (name === "create_card") {
        const projectId = String(args.projectId);
        const project = await loadActiveProject(db, projectId);
        const key = decrypt(project.trello.apiKeyEncrypted, cfg.ENCRYPTION_KEY);
        const token = decrypt(project.trello.tokenEncrypted, cfg.ENCRYPTION_KEY);
        const title = String(args.title);
        const description = String(args.description);
        const checklist = (args.checklist as string[] | undefined) || [];
        const url = trelloUrl("/1/cards", key, token);
        const createRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: title,
            desc: description,
            idList: project.trello.inboxListId,
            pos: "top",
          }),
        });
        if (!createRes.ok) {
          throw new Error(`Trello create_card failed: ${createRes.status} ${await createRes.text()}`);
        }
        const card = (await createRes.json()) as { id: string; shortUrl?: string; url?: string };
        if (checklist.length) {
          const clUrl = trelloUrl(`/1/cards/${card.id}/checklists`, key, token);
          const clRes = await fetch(clUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Requirements" }),
          });
          if (!clRes.ok) throw new Error(`Trello checklist create failed: ${await clRes.text()}`);
          const cl = (await clRes.json()) as { id: string };
          for (const item of checklist) {
            const itemUrl = trelloUrl(`/1/checklists/${cl.id}/checkItems`, key, token);
            await fetch(itemUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: item }),
            });
          }
        }
        result = { cardId: card.id, cardUrl: card.url || card.shortUrl };
      } else if (name === "add_card_comment") {
        const cardId = String(args.cardId);
        const text = String(args.text);
        const qs = await db.collection(collections.emailThreads).where("trelloCardId", "==", cardId).limit(1).get();
        if (qs.empty) {
          throw new Error("Unable to infer project for card comment (no thread with trelloCardId)");
        }
        const th = qs.docs[0].data() as { projectId: string };
        const project = await loadActiveProject(db, th.projectId);
        const key = decrypt(project.trello.apiKeyEncrypted, cfg.ENCRYPTION_KEY);
        const token = decrypt(project.trello.tokenEncrypted, cfg.ENCRYPTION_KEY);
        const url = trelloUrl(`/1/cards/${cardId}/actions/comments`, key, token);
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(await res.text());
        result = { ok: true };
      } else if (name === "get_card") {
        const cardId = String(args.cardId);
        const qs = await db.collection(collections.emailThreads).where("trelloCardId", "==", cardId).limit(1).get();
        if (qs.empty) throw new Error("Unable to infer project for get_card");
        const th = qs.docs[0].data() as { projectId: string };
        const project = await loadActiveProject(db, th.projectId);
        const key = decrypt(project.trello.apiKeyEncrypted, cfg.ENCRYPTION_KEY);
        const token = decrypt(project.trello.tokenEncrypted, cfg.ENCRYPTION_KEY);
        const url = trelloUrl(`/1/cards/${cardId}`, key, token);
        const res = await fetch(url);
        if (!res.ok) throw new Error(await res.text());
        result = await res.json();
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      const durationMs = Date.now() - t0;
      await audit(db, name, args, result, durationMs, String(args.projectId));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      const durationMs = Date.now() - t0;
      const err = e instanceof Error ? e.message : String(e);
      await audit(db, name, args, { error: err }, durationMs, String(args.projectId));
      return { content: [{ type: "text", text: JSON.stringify({ error: err }) }], isError: true };
    }
  });

  void server.connect(new StdioServerTransport());
}

start();
