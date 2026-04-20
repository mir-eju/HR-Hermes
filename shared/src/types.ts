import type { Timestamp } from "firebase-admin/firestore";

/** Stored Firestore timestamps (admin SDK `Timestamp`, wire JSON, or `Date`). */
export type FirebaseTimestamp = Timestamp | { _seconds: number; _nanoseconds: number } | Date;

export type ThreadState =
  | "received"
  | "extracted"
  | "carded"
  | "drafted"
  | "awaiting_approval"
  | "approved"
  | "sent"
  | "rejected"
  | "closed"
  | "edited";

export type ChangeType =
  | "new_feature"
  | "modification"
  | "bug_fix"
  | "removal"
  | "clarification"
  | "not_a_requirement";

export interface Team {
  id: string;
  name: string;
  active: boolean;
  createdAt: FirebaseTimestamp;
  updatedAt: FirebaseTimestamp;
}

export interface ProjectGmail {
  inboxEmail: string;
  /** Composio entity id for the connected Gmail account (used with `COMPOSIO_API_KEY`). */
  composioUserId: string;
  watchLabel: string;
}

export interface ProjectTrello {
  apiKeyEncrypted: string;
  tokenEncrypted: string;
  boardId: string;
  inboxListId: string;
}

export interface ProjectSlack {
  botTokenEncrypted: string;
  channelId: string;
  workspaceId: string;
}

export interface ProjectPrompts {
  extractionAddendum: string;
  replySignature: string;
  replyToneNotes: string;
}

export interface ProjectSkills {
  extraction: string;
  drafting: string;
}

export interface ProjectLearning {
  enabled: boolean;
}

export interface Project {
  id: string;
  teamId: string;
  name: string;
  clientName: string;
  active: boolean;
  createdAt: FirebaseTimestamp;
  updatedAt: FirebaseTimestamp;
  gmail: ProjectGmail;
  trello: ProjectTrello;
  slack: ProjectSlack;
  prompts: ProjectPrompts;
  skills: ProjectSkills;
  learning?: ProjectLearning;
  dryRun?: boolean;
  lastPolledAt?: FirebaseTimestamp | null;
  lastPollError?: string | null;
}

export interface StateHistoryEntry {
  state: ThreadState;
  at: FirebaseTimestamp;
  by: string;
  step: string;
}

export interface ThreadExtraction {
  summary: string;
  changeType: ChangeType;
  requirements: string[];
  affectedAreas: string[];
  openQuestions: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
}

export interface ThreadError {
  at: FirebaseTimestamp;
  step: string;
  message: string;
}

export interface HumanEdits {
  extractionBefore?: string;
  extractionAfter?: string;
  replyBefore?: string;
  replyAfter?: string;
  reflectedAt?: FirebaseTimestamp | null;
}

export interface EmailThread {
  id: string;
  teamId: string;
  projectId: string;
  gmailThreadId: string;
  clientEmail: string;
  clientName: string;
  subject: string;
  firstReceivedAt: FirebaseTimestamp;
  lastMessageAt: FirebaseTimestamp;
  rawEmail?: string;
  rawEmailHistory?: string[];
  lastMessageIdHeader?: string;
  state: ThreadState;
  stateHistory: StateHistoryEntry[];
  extraction?: ThreadExtraction;
  trelloCardId?: string;
  trelloCardUrl?: string;
  draftedReply?: string;
  editedReply?: string;
  sentReply?: string;
  slackMessageTs?: string;
  slackChannelId?: string;
  approvedBy?: string;
  errors?: ThreadError[];
  humanEdits?: HumanEdits;
}

export interface ApprovalToken {
  id: string;
  threadId: string;
  projectId: string;
  kind: "send_reply";
  payloadHash: string;
  issuedAt: FirebaseTimestamp;
  expiresAt: FirebaseTimestamp;
  used: boolean;
  usedAt?: FirebaseTimestamp;
  usedBy?: string;
  issuedBy?: string;
}

export type AuditKind =
  | "tool_call"
  | "hook"
  | "skill_update"
  | "approval_issued"
  | "approval_consumed";

export interface AuditLogEntry {
  id?: string;
  at: FirebaseTimestamp;
  projectId?: string;
  threadId?: string;
  kind: AuditKind;
  tool?: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  sessionId?: string;
  hermesTurnId?: string;
  dryRun?: boolean;
}

export interface ApprovalSignal {
  threadId: string;
  action: "approve_reply" | "reject_reply" | "edit_reply" | "approved" | "rejected" | "edited";
  userId?: string;
  at: FirebaseTimestamp;
  tokenId?: string;
  consumed?: boolean;
}

export interface SkillReviewQueueEntry {
  id: string;
  projectId: string;
  skillFile: string;
  diff: string;
  addedAt: FirebaseTimestamp;
  status?: "pending" | "approved" | "rejected";
  previousContent?: string;
}
