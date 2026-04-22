#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import prompts from "prompts";
import { createInterface } from "node:readline";
import { collections, decrypt, initFirebaseFromConfig, loadConfig, writeAuditLog } from "@hr-hermes/shared";
import type { AuditKind } from "@hr-hermes/shared";
import {
  createProject,
  getProject,
  listProjects,
  setGlobalDryRunFlag,
  setLearningEnabled,
  setProjectActive,
  setProjectClientName,
  setProjectDryRun,
  updateProjectGmailSettings,
  updateProjectSlackSettings,
  updateProjectTelegramSettings,
  updateProjectTrelloCredentials,
} from "./repos/projects.js";
import { createTeam, getTeam, listTeams } from "./repos/teams.js";
import { writeProjectSkillFiles } from "./skillWriter.js";

function repoRoot(): string {
  const cfg = loadConfig();
  return resolve(cfg.hrHermesRoot);
}

async function readMultiline(message: string): Promise<string> {
  console.log(`${message} (end with a line containing only EOF on a new line, or type END)`);
  const lines: string[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of rl) {
    if (line.trim() === "END" || line.trim() === "EOF") break;
    lines.push(line);
  }
  rl.close();
  return lines.join("\n");
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function cmdAddTeam(argv: string[]) {
  const args = parseArgs(argv);
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const id = (args.id as string) || (await prompts({ type: "text", name: "id", message: "Team id" })).id;
  const name =
    (args.name as string) || (await prompts({ type: "text", name: "name", message: "Team name" })).name;
  if (!id || !name) throw new Error("id and name required");
  await createTeam(db, { id: String(id), name: String(name) });
  console.log(`Created team ${id}`);
}

async function cmdAddProject(argv: string[]) {
  const args = parseArgs(argv);
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const interactive = Boolean(args.interactive) || argv.length === 0;

  const id = interactive
    ? String((await prompts({ type: "text", name: "id", message: "Project id" })).id || "")
    : String(args.id || "");
  const name = interactive
    ? String((await prompts({ type: "text", name: "name", message: "Project name" })).name || "")
    : String(args.name || "");
  const teamId = interactive
    ? String((await prompts({ type: "text", name: "teamId", message: "Team id" })).teamId || "")
    : String(args.teamId || "");
  const clientName = interactive
    ? String((await prompts({ type: "text", name: "clientName", message: "Client name" })).clientName || "")
    : String(args.clientName || "");

  if (!id || !name || !teamId || !clientName) throw new Error("Missing required fields");
  const team = await getTeam(db, teamId);
  if (!team) throw new Error(`Unknown team: ${teamId}`);

  const inboxEmail = interactive
    ? String((await prompts({ type: "text", name: "inboxEmail", message: "Gmail inbox email (for reference)" })).inboxEmail || "")
    : String(args.inboxEmail || "");
  if (!inboxEmail) throw new Error("inboxEmail required");

  const composioUserId = interactive
    ? String(
        (await prompts({
          type: "text",
          name: "composioUserId",
          message:
            "Composio entity user_id (end-user id), not Gmail address and not ac_/ca_ connection id",
        })).composioUserId || ""
      )
    : String(args.composioUserId || "");
  if (!composioUserId.trim()) throw new Error("composioUserId required (connect Gmail in Composio first)");

  const composioConnectedAccountId = interactive
    ? String(
        (await prompts({
          type: "text",
          name: "composioConnectedAccountId",
          message: "Composio connected-account id (ac_…) — Enter to skip",
        })).composioConnectedAccountId || ""
      )
    : String(args.composioConnectedAccountId || "");

  const trelloApiKey = interactive
    ? String((await prompts({ type: "password", name: "v", message: "Trello API key" })).v || "")
    : String(args.trelloApiKey || "");
  const trelloToken = interactive
    ? String((await prompts({ type: "password", name: "v", message: "Trello token" })).v || "")
    : String(args.trelloToken || "");
  const boardId = interactive
    ? String((await prompts({ type: "text", name: "v", message: "Trello board id" })).v || "")
    : String(args.boardId || "");
  const inboxListId = interactive
    ? String((await prompts({ type: "text", name: "v", message: "Trello inbox list id" })).v || "")
    : String(args.inboxListId || "");

  const slackBotToken = interactive
    ? String(
        (await prompts({ type: "password", name: "v", message: "Slack bot token (xoxb-…) — Enter to skip" })).v || ""
      )
    : String(args.slackBotToken || "");
  const slackChannelId = interactive
    ? String((await prompts({ type: "text", name: "v", message: "Slack channel id — Enter to skip" })).v || "")
    : String(args.slackChannelId || "");
  const slackWorkspaceId = interactive
    ? String((await prompts({ type: "text", name: "v", message: "Slack workspace id — Enter to skip" })).v || "")
    : String(args.slackWorkspaceId || "");

  const telegramBotToken = interactive
    ? String(
        (await prompts({
          type: "password",
          name: "v",
          message: "Telegram bot token (@BotFather) — Enter to skip if using Slack only",
        })).v || ""
      )
    : String(args.telegramBotToken || "");
  const telegramChatId = interactive
    ? String(
        (await prompts({
          type: "text",
          name: "v",
          message: "Telegram chat id — Enter to skip (DM/group id from getUpdates)",
        })).v || ""
      )
    : String(args.telegramChatId || "");

  const hasSlack = Boolean(slackBotToken && slackChannelId.trim() && slackWorkspaceId.trim());
  const hasTelegram = Boolean(telegramBotToken && telegramChatId.trim());
  if (!hasSlack && !hasTelegram) {
    throw new Error("Provide Slack (bot + channel + workspace) and/or Telegram (bot + chat id)");
  }

  const extractionAddendum = interactive
    ? await readMultiline("Extraction addendum")
    : String(args.extractionAddendum || "");
  const replySignature = interactive
    ? String((await prompts({ type: "text", name: "v", message: "Reply signature (multi-line ok in quotes)" })).v || "")
    : String(args.replySignature || "");
  const replyToneNotes = interactive
    ? String((await prompts({ type: "text", name: "v", message: "Reply tone notes" })).v || "")
    : String(args.replyToneNotes || "");

  const watchLabel = interactive
    ? String(
        (await prompts({
          type: "text",
          name: "watchLabel",
          message: "Gmail label to watch (INBOX or label name)",
          initial: "INBOX",
        })).watchLabel || "INBOX"
      )
    : String(args.watchLabel || "INBOX");

  await createProject(db, cfg.ENCRYPTION_KEY, {
    id,
    teamId,
    name,
    clientName,
    gmail: {
      inboxEmail,
      composioUserId: composioUserId.trim(),
      ...(composioConnectedAccountId.trim()
        ? { composioConnectedAccountId: composioConnectedAccountId.trim() }
        : {}),
      watchLabel,
    },
    trello: { apiKey: trelloApiKey, token: trelloToken, boardId, inboxListId },
    ...(hasSlack
      ? {
          slack: {
            botToken: slackBotToken,
            channelId: slackChannelId.trim(),
            workspaceId: slackWorkspaceId.trim(),
          },
        }
      : {}),
    ...(hasTelegram
      ? { telegram: { botToken: telegramBotToken, chatId: telegramChatId.trim() } }
      : {}),
    prompts: { extractionAddendum, replySignature, replyToneNotes },
    learningEnabled: false,
    dryRun: false,
  });

  writeProjectSkillFiles(repoRoot(), id, {
    extractionAddendum,
    replySignature,
    replyToneNotes,
  });
  console.log(`Created project ${id} and wrote skill files under hermes/skills/projects/${id}/`);
}

async function cmdListProjects() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const projects = await listProjects(db);
  console.log(JSON.stringify(projects.map((p) => ({ id: p.id, name: p.name, teamId: p.teamId, active: p.active })), null, 2));
}

async function cmdDisableProject(argv: string[]) {
  const id = argv[0];
  if (!id) throw new Error("Usage: disable-project <id>");
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  await setProjectActive(db, id, false);
  console.log(`Disabled project ${id}`);
}

async function cmdDryRun(argv: string[]) {
  const mode = argv[0];
  if (mode !== "on" && mode !== "off") throw new Error("Usage: dry-run <on|off>");
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  await setGlobalDryRunFlag(db, mode === "on");
  console.log(`Global dry-run flag set to ${mode === "on"}`);
}

async function cmdDryRunProject(argv: string[]) {
  const projectId = argv[0];
  const mode = argv[1];
  if (!projectId || (mode !== "on" && mode !== "off")) {
    throw new Error("Usage: dry-run-project <projectId> <on|off>");
  }
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  await setProjectDryRun(db, projectId, mode === "on");
  console.log(`Project ${projectId} dryRun=${mode === "on"}`);
}

async function cmdHookAudit() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = JSON.parse(raw) as {
    kind: AuditKind;
    tool?: string;
    input?: unknown;
    output?: unknown;
    durationMs?: number;
    sessionId?: string;
    hermesTurnId?: string;
    projectId?: string;
    threadId?: string;
  };
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  await writeAuditLog(db, body.kind || "hook", {
    tool: body.tool,
    input: body.input,
    output: body.output,
    durationMs: body.durationMs,
    sessionId: body.sessionId,
    hermesTurnId: body.hermesTurnId,
    projectId: body.projectId,
    threadId: body.threadId,
  });
}

async function cmdSkillReview() {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const qs = await db
    .collection(collections.skillReviewQueue)
    .where("status", "==", "pending")
    .orderBy("addedAt", "desc")
    .limit(20)
    .get()
    .catch(async () => {
      return await db.collection(collections.skillReviewQueue).limit(20).get();
    });

  const entries = qs.docs.map((d) => ({ id: d.id, ...(d.data() as object) }));
  if (!entries.length) {
    console.log("No pending skill review entries.");
    return;
  }
  console.log(JSON.stringify(entries, null, 2));
  const { action, id } = await prompts([
    { type: "select", name: "action", message: "Action", choices: [
      { title: "Approve (mark done)", value: "approve" },
      { title: "Reject (revert file)", value: "reject" },
      { title: "Quit", value: "quit" },
    ]},
    { type: "text", name: "id", message: "Entry id" },
  ]);
  if (action === "quit" || !id) return;
  const doc = await db.collection(collections.skillReviewQueue).doc(String(id)).get();
  if (!doc.exists) throw new Error("Unknown entry");
  const data = doc.data() as { skillFile?: string; previousContent?: string; projectId?: string };
  if (action === "approve") {
    await doc.ref.update({ status: "approved" });
    console.log("Marked approved.");
    return;
  }
  if (action === "reject" && data.skillFile && data.previousContent !== undefined) {
    const rel = String(data.skillFile).replace(/^skills\//, "");
    const path = resolve(repoRoot(), "hermes", "skills", rel);
    writeFileSync(path, data.previousContent, "utf8");
    await doc.ref.update({ status: "rejected" });
    console.log("Reverted skill file and marked rejected.");
  }
}

async function cmdLearning(argv: string[]) {
  const projectId = argv[0];
  const mode = argv[1];
  if (!projectId || (mode !== "on" && mode !== "off")) {
    throw new Error("Usage: learning <projectId> <on|off>");
  }
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  await setLearningEnabled(db, projectId, mode === "on");
  console.log(`Project ${projectId} learning.enabled=${mode === "on"}`);
}

async function cmdDecryptProjectField(projectId: string, field: string) {
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const p = await getProject(db, projectId);
  if (!p) throw new Error("Unknown project");
  let enc: string | undefined;
  if (field === "slack.botToken") enc = p.slack?.botTokenEncrypted;
  else if (field === "telegram.botToken") enc = p.telegram?.botTokenEncrypted;
  else throw new Error("Unsupported field (use slack.botToken or telegram.botToken)");
  if (!enc) throw new Error("Field not set on this project");
  console.log(decrypt(enc, cfg.ENCRYPTION_KEY));
}

async function cmdUpdateProjectGmail(argv: string[]) {
  const args = parseArgs(argv);
  const projectId = String(args.id || args.projectId || "");
  if (!projectId) {
    throw new Error(
      "Usage: update-project-gmail --id <projectId> [--composioUserId <id>] [--composioConnectedAccountId <ac_…>] [--inboxEmail <email>] [--watchLabel <label>]\n" +
        "  At least one of composioUserId, composioConnectedAccountId, inboxEmail, watchLabel is required.\n" +
        "  composioUserId = Composio entity user_id; composioConnectedAccountId = optional ac_… row id."
    );
  }
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  const patch: {
    composioUserId?: string;
    composioConnectedAccountId?: string | null;
    inboxEmail?: string;
    watchLabel?: string;
  } = {};
  if (args.composioUserId) patch.composioUserId = String(args.composioUserId);
  if (args.composioConnectedAccountId !== undefined) {
    patch.composioConnectedAccountId =
      args.composioConnectedAccountId === true ? null : String(args.composioConnectedAccountId);
  }
  if (args.inboxEmail) patch.inboxEmail = String(args.inboxEmail);
  if (args.watchLabel) patch.watchLabel = String(args.watchLabel);
  await updateProjectGmailSettings(db, projectId, patch);
  console.log(`Updated gmail settings on project ${projectId}`);
}

async function cmdUpdateProjectTrello(argv: string[]) {
  const args = parseArgs(argv);
  const projectId = String(args.id || args.projectId || "");
  if (!projectId) {
    throw new Error(
      "Usage: update-project-trello --id <projectId> [--apiKey <key>] [--token <token>] [--boardId <id>] [--inboxListId <id>]\n" +
        "  At least one flag required. apiKey/token are encrypted with ENCRYPTION_KEY before Firestore update."
    );
  }
  const patch: {
    apiKey?: string;
    token?: string;
    boardId?: string;
    inboxListId?: string;
  } = {};
  if (args.apiKey) patch.apiKey = String(args.apiKey);
  if (args.token) patch.token = String(args.token);
  if (args.boardId) patch.boardId = String(args.boardId);
  if (args.inboxListId) patch.inboxListId = String(args.inboxListId);
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  await updateProjectTrelloCredentials(db, cfg.ENCRYPTION_KEY, projectId, patch);
  console.log(`Updated Trello credentials/settings on project ${projectId}`);
}

async function cmdUpdateProjectTelegram(argv: string[]) {
  const args = parseArgs(argv);
  const projectId = String(args.id || args.projectId || "");
  if (!projectId) {
    throw new Error(
      "Usage: update-project-telegram --id <projectId> [--botToken <token>] [--chatId <id>]\n" +
        "  At least one flag required. chatId must be a user DM or group (not another bot). First-time telegram needs both flags."
    );
  }
  const patch: { botToken?: string; chatId?: string } = {};
  if (args.botToken) patch.botToken = String(args.botToken);
  if (args.chatId) patch.chatId = String(args.chatId);
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  await updateProjectTelegramSettings(db, cfg.ENCRYPTION_KEY, projectId, patch);
  console.log(`Updated Telegram settings on project ${projectId}`);
}

async function cmdUpdateProjectSlack(argv: string[]) {
  const args = parseArgs(argv);
  const projectId = String(args.id || args.projectId || "");
  if (!projectId) {
    throw new Error(
      "Usage: update-project-slack --id <projectId> [--botToken <xoxb-…>] [--channelId <id>] [--workspaceId <id>]\n" +
        "  At least one flag required. First-time slack needs all three flags."
    );
  }
  const patch: { botToken?: string; channelId?: string; workspaceId?: string } = {};
  if (args.botToken) patch.botToken = String(args.botToken);
  if (args.channelId) patch.channelId = String(args.channelId);
  if (args.workspaceId) patch.workspaceId = String(args.workspaceId);
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  await updateProjectSlackSettings(db, cfg.ENCRYPTION_KEY, projectId, patch);
  console.log(`Updated Slack settings on project ${projectId}`);
}

async function cmdSetClientName(argv: string[]) {
  const args = parseArgs(argv);
  const projectId = String(args.id || args.projectId || "");
  const clientName = String(args.name || args.clientName || "");
  if (!projectId || !clientName) {
    throw new Error("Usage: set-client-name --id <projectId> --name \"Client display name\"");
  }
  const cfg = loadConfig();
  const db = initFirebaseFromConfig(cfg);
  await setProjectClientName(db, projectId, clientName);
  console.log(`Updated clientName on project ${projectId}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.log(
      "Commands: add-team | add-project | list-projects | list-teams | disable-project | dry-run | dry-run-project | learning | hook-audit | skill-review | decrypt-field | update-project-gmail | update-project-trello | update-project-telegram | update-project-slack | set-client-name"
    );
    process.exit(1);
  }
  switch (cmd) {
    case "add-team":
      await cmdAddTeam(rest);
      break;
    case "add-project":
      await cmdAddProject(rest);
      break;
    case "list-projects":
      await cmdListProjects();
      break;
    case "list-teams": {
      const cfg = loadConfig();
      const db = initFirebaseFromConfig(cfg);
      console.log(JSON.stringify(await listTeams(db), null, 2));
      break;
    }
    case "disable-project":
      await cmdDisableProject(rest);
      break;
    case "dry-run":
      await cmdDryRun(rest);
      break;
    case "dry-run-project":
      await cmdDryRunProject(rest);
      break;
    case "learning":
      await cmdLearning(rest);
      break;
    case "hook-audit":
      await cmdHookAudit();
      break;
    case "skill-review":
      await cmdSkillReview();
      break;
    case "decrypt-field":
      await cmdDecryptProjectField(String(rest[0]), String(rest[1]));
      break;
    case "update-project-gmail":
      await cmdUpdateProjectGmail(rest);
      break;
    case "update-project-trello":
      await cmdUpdateProjectTrello(rest);
      break;
    case "update-project-telegram":
      await cmdUpdateProjectTelegram(rest);
      break;
    case "update-project-slack":
      await cmdUpdateProjectSlack(rest);
      break;
    case "set-client-name":
      await cmdSetClientName(rest);
      break;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
