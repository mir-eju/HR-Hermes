import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { collections, encrypt, now } from "@hr-hermes/shared";
import type {
  Project,
  ProjectGmail,
  ProjectLearning,
  ProjectPrompts,
  ProjectSkills,
  ProjectSlack,
  ProjectTelegram,
  ProjectTrello,
} from "@hr-hermes/shared";

export interface CreateProjectPlaintext {
  id: string;
  teamId: string;
  name: string;
  clientName: string;
  gmail: {
    inboxEmail: string;
    composioUserId: string;
    composioConnectedAccountId?: string;
    watchLabel: string;
  };
  trello: {
    apiKey: string;
    token: string;
    boardId: string;
    inboxListId: string;
  };
  slack?: {
    botToken: string;
    channelId: string;
    workspaceId: string;
  };
  telegram?: {
    botToken: string;
    chatId: string;
  };
  prompts: ProjectPrompts;
  learningEnabled?: boolean;
  dryRun?: boolean;
}

function buildGmail(p: CreateProjectPlaintext["gmail"]): ProjectGmail {
  const composioConnectedAccountId = p.composioConnectedAccountId?.trim();
  return {
    inboxEmail: p.inboxEmail,
    composioUserId: p.composioUserId.trim(),
    ...(composioConnectedAccountId ? { composioConnectedAccountId } : {}),
    watchLabel: p.watchLabel || "INBOX",
  };
}

function encryptTrello(p: CreateProjectPlaintext["trello"], key: string): ProjectTrello {
  return {
    apiKeyEncrypted: encrypt(p.apiKey, key),
    tokenEncrypted: encrypt(p.token, key),
    boardId: p.boardId,
    inboxListId: p.inboxListId,
  };
}

function encryptSlack(p: NonNullable<CreateProjectPlaintext["slack"]>, key: string): ProjectSlack {
  return {
    botTokenEncrypted: encrypt(p.botToken, key),
    channelId: p.channelId,
    workspaceId: p.workspaceId,
  };
}

function encryptTelegram(p: NonNullable<CreateProjectPlaintext["telegram"]>, key: string): ProjectTelegram {
  return {
    botTokenEncrypted: encrypt(p.botToken, key),
    chatId: p.chatId.trim(),
  };
}

export async function createProject(
  db: Firestore,
  encryptionKey: string,
  input: CreateProjectPlaintext
): Promise<void> {
  if (!input.slack && !input.telegram) {
    throw new Error("Configure at least one of: slack (bot + channel) or telegram (bot + chat id)");
  }
  const ref = db.collection(collections.projects).doc(input.id);
  if ((await ref.get()).exists) {
    throw new Error(`Project already exists: ${input.id}`);
  }
  const t = now();
  const skills: ProjectSkills = {
    extraction: `skills/projects/${input.id}/extraction.md`,
    drafting: `skills/projects/${input.id}/drafting.md`,
  };
  const learning: ProjectLearning = { enabled: Boolean(input.learningEnabled) };
  const project: Project = {
    id: input.id,
    teamId: input.teamId,
    name: input.name,
    clientName: input.clientName,
    active: true,
    createdAt: t as unknown as Project["createdAt"],
    updatedAt: t as unknown as Project["updatedAt"],
    gmail: buildGmail(input.gmail),
    trello: encryptTrello(input.trello, encryptionKey),
    prompts: input.prompts,
    skills,
    learning,
    dryRun: input.dryRun ?? false,
    lastPolledAt: null,
    lastPollError: null,
  };
  if (input.slack) project.slack = encryptSlack(input.slack, encryptionKey);
  if (input.telegram) project.telegram = encryptTelegram(input.telegram, encryptionKey);
  await ref.set(project);
}

export async function getProject(db: Firestore, id: string): Promise<Project | null> {
  const snap = await db.collection(collections.projects).doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as Project;
}

export async function listActiveProjects(db: Firestore): Promise<Project[]> {
  const qs = await db.collection(collections.projects).where("active", "==", true).get();
  return qs.docs.map((d) => d.data() as Project);
}

export async function listProjects(db: Firestore): Promise<Project[]> {
  const qs = await db.collection(collections.projects).get();
  return qs.docs.map((d) => d.data() as Project);
}

export async function setProjectActive(db: Firestore, id: string, active: boolean): Promise<void> {
  await db.collection(collections.projects).doc(id).update({ active, updatedAt: now() });
}

/** Rotate Trello API key / token (encrypted) and/or board ids (plaintext). */
export async function updateProjectTrelloCredentials(
  db: Firestore,
  encryptionKey: string,
  projectId: string,
  patch: { apiKey?: string; token?: string; boardId?: string; inboxListId?: string }
): Promise<void> {
  const ref = db.collection(collections.projects).doc(projectId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  const updates: Record<string, unknown> = { updatedAt: now() };
  if (patch.apiKey !== undefined) {
    updates["trello.apiKeyEncrypted"] = encrypt(patch.apiKey.trim(), encryptionKey);
  }
  if (patch.token !== undefined) {
    updates["trello.tokenEncrypted"] = encrypt(patch.token.trim(), encryptionKey);
  }
  if (patch.boardId !== undefined) updates["trello.boardId"] = patch.boardId.trim();
  if (patch.inboxListId !== undefined) updates["trello.inboxListId"] = patch.inboxListId.trim();
  const keys = Object.keys(updates).filter((k) => k !== "updatedAt");
  if (!keys.length) throw new Error("Provide at least one of: apiKey, token, boardId, inboxListId");
  await ref.update(updates);
}

/** Rotate Telegram bot token (encrypted) and/or approvals chat id. */
export async function updateProjectTelegramSettings(
  db: Firestore,
  encryptionKey: string,
  projectId: string,
  patch: { botToken?: string; chatId?: string }
): Promise<void> {
  const ref = db.collection(collections.projects).doc(projectId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  const p = snap.data() as Project;
  const hadTelegram = Boolean(p.telegram);
  const updates: Record<string, unknown> = { updatedAt: now() };
  if (patch.botToken !== undefined) {
    updates["telegram.botTokenEncrypted"] = encrypt(patch.botToken.trim(), encryptionKey);
  }
  if (patch.chatId !== undefined) {
    updates["telegram.chatId"] = patch.chatId.trim();
  }
  const keys = Object.keys(updates).filter((k) => k !== "updatedAt");
  if (!keys.length) throw new Error("Provide at least one of: botToken, chatId");
  if (!hadTelegram && (patch.botToken === undefined || patch.chatId === undefined)) {
    throw new Error("Project has no telegram yet: pass both --botToken and --chatId");
  }
  await ref.update(updates);
}

/** Rotate Slack bot token (encrypted) and/or channel / workspace ids. */
export async function updateProjectSlackSettings(
  db: Firestore,
  encryptionKey: string,
  projectId: string,
  patch: { botToken?: string; channelId?: string; workspaceId?: string }
): Promise<void> {
  const ref = db.collection(collections.projects).doc(projectId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  const p = snap.data() as Project;
  const hadSlack = Boolean(p.slack);
  const updates: Record<string, unknown> = { updatedAt: now() };
  if (patch.botToken !== undefined) {
    updates["slack.botTokenEncrypted"] = encrypt(patch.botToken.trim(), encryptionKey);
  }
  if (patch.channelId !== undefined) updates["slack.channelId"] = patch.channelId.trim();
  if (patch.workspaceId !== undefined) updates["slack.workspaceId"] = patch.workspaceId.trim();
  const keys = Object.keys(updates).filter((k) => k !== "updatedAt");
  if (!keys.length) throw new Error("Provide at least one of: botToken, channelId, workspaceId");
  if (
    !hadSlack &&
    (patch.botToken === undefined || patch.channelId === undefined || patch.workspaceId === undefined)
  ) {
    throw new Error("Project has no slack yet: pass --botToken, --channelId, and --workspaceId");
  }
  await ref.update(updates);
}

export async function setProjectComposioUserId(
  db: Firestore,
  projectId: string,
  composioUserId: string
): Promise<void> {
  await db
    .collection(collections.projects)
    .doc(projectId)
    .update({ "gmail.composioUserId": composioUserId.trim(), updatedAt: now() });
}

export async function setProjectClientName(db: Firestore, projectId: string, clientName: string): Promise<void> {
  const ref = db.collection(collections.projects).doc(projectId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  await ref.update({ clientName: clientName.trim(), updatedAt: now() });
}

/** Patch plaintext Gmail metadata on the project (Composio identity + labels). */
export async function updateProjectGmailSettings(
  db: Firestore,
  projectId: string,
  patch: {
    composioUserId?: string;
    composioConnectedAccountId?: string | null;
    inboxEmail?: string;
    watchLabel?: string;
  }
): Promise<void> {
  const ref = db.collection(collections.projects).doc(projectId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Unknown project: ${projectId}`);
  const updates: Record<string, unknown> = { updatedAt: now() };
  if (patch.composioUserId !== undefined) updates["gmail.composioUserId"] = patch.composioUserId.trim();
  if (patch.composioConnectedAccountId !== undefined) {
    const v = patch.composioConnectedAccountId;
    if (v === null || (typeof v === "string" && !v.trim())) {
      updates["gmail.composioConnectedAccountId"] = FieldValue.delete();
    } else {
      updates["gmail.composioConnectedAccountId"] = String(v).trim();
    }
  }
  if (patch.inboxEmail !== undefined) updates["gmail.inboxEmail"] = patch.inboxEmail.trim();
  if (patch.watchLabel !== undefined) updates["gmail.watchLabel"] = patch.watchLabel.trim();
  const keys = Object.keys(updates).filter((k) => k !== "updatedAt");
  if (!keys.length) {
    throw new Error(
      "Provide at least one of: composioUserId, composioConnectedAccountId, inboxEmail, watchLabel"
    );
  }
  await ref.update(updates);
}

export async function setProjectDryRun(db: Firestore, projectId: string, dryRun: boolean): Promise<void> {
  await db.collection(collections.projects).doc(projectId).update({ dryRun, updatedAt: now() });
}

export async function setGlobalDryRunFlag(db: Firestore, dryRun: boolean): Promise<void> {
  const ref = db.collection("_config").doc("runtime");
  await ref.set({ dryRun, updatedAt: now() }, { merge: true });
}

export async function getRuntimeConfig(db: Firestore): Promise<{ dryRun?: boolean } | null> {
  const snap = await db.collection("_config").doc("runtime").get();
  if (!snap.exists) return null;
  return snap.data() as { dryRun?: boolean };
}

export async function setLearningEnabled(
  db: Firestore,
  projectId: string,
  enabled: boolean
): Promise<void> {
  await db
    .collection(collections.projects)
    .doc(projectId)
    .update({ "learning.enabled": enabled, updatedAt: now() });
}
