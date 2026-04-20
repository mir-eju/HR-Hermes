import type { Firestore } from "firebase-admin/firestore";
import { collections, encrypt, now } from "@hr-hermes/shared";
import type { Project, ProjectGmail, ProjectLearning, ProjectPrompts, ProjectSkills, ProjectSlack, ProjectTrello } from "@hr-hermes/shared";

export interface CreateProjectPlaintext {
  id: string;
  teamId: string;
  name: string;
  clientName: string;
  gmail: {
    inboxEmail: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    watchLabel: string;
  };
  trello: {
    apiKey: string;
    token: string;
    boardId: string;
    inboxListId: string;
  };
  slack: {
    botToken: string;
    channelId: string;
    workspaceId: string;
  };
  prompts: ProjectPrompts;
  learningEnabled?: boolean;
  dryRun?: boolean;
}

function encryptGmail(p: CreateProjectPlaintext["gmail"], key: string): ProjectGmail {
  return {
    inboxEmail: p.inboxEmail,
    clientIdEncrypted: encrypt(p.clientId, key),
    clientSecretEncrypted: encrypt(p.clientSecret, key),
    refreshTokenEncrypted: encrypt(p.refreshToken, key),
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

function encryptSlack(p: CreateProjectPlaintext["slack"], key: string): ProjectSlack {
  return {
    botTokenEncrypted: encrypt(p.botToken, key),
    channelId: p.channelId,
    workspaceId: p.workspaceId,
  };
}

export async function createProject(
  db: Firestore,
  encryptionKey: string,
  input: CreateProjectPlaintext
): Promise<void> {
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
    gmail: encryptGmail(input.gmail, encryptionKey),
    trello: encryptTrello(input.trello, encryptionKey),
    slack: encryptSlack(input.slack, encryptionKey),
    prompts: input.prompts,
    skills,
    learning,
    dryRun: input.dryRun ?? false,
    lastPolledAt: null,
    lastPollError: null,
  };
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

export async function updateProjectSecretField(
  db: Firestore,
  encryptionKey: string,
  projectId: string,
  path: "gmail.refreshTokenEncrypted" | "gmail.clientIdEncrypted" | "trello.tokenEncrypted",
  plaintext: string
): Promise<void> {
  const enc = encrypt(plaintext, encryptionKey);
  const ref = db.collection(collections.projects).doc(projectId);
  await ref.update({ [path]: enc, updatedAt: now() });
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
