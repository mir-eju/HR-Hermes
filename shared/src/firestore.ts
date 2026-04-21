import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applicationDefault, cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import type { AppConfig } from "./config.js";

export function initFirebaseFromConfig(cfg: AppConfig) {
  if (getApps().length > 0) {
    return getFirestore();
  }
  const path = resolve(cfg.FIREBASE_SERVICE_ACCOUNT_PATH);
  const serviceAccount = JSON.parse(readFileSync(path, "utf8")) as ServiceAccount & {
    project_id?: string;
  };
  initializeApp({
    credential: cert(serviceAccount),
    projectId: cfg.FIREBASE_PROJECT_ID || serviceAccount.project_id || serviceAccount.projectId,
  });
  return getFirestore();
}

/** Use when running in environments that already have ADC (e.g. CI). */
export function initFirebaseApplicationDefault(projectId: string) {
  if (getApps().length > 0) {
    return getFirestore();
  }
  initializeApp({
    credential: applicationDefault(),
    projectId,
  });
  return getFirestore();
}

export function now() {
  return Timestamp.now();
}

export const collections = {
  teams: "teams",
  projects: "projects",
  emailThreads: "emailThreads",
  approvalTokens: "approvalTokens",
  auditLog: "auditLog",
  approvalSignals: "approvalSignals",
  dryRunOutbox: "dryRunOutbox",
  skillReviewQueue: "skillReviewQueue",
  healthcheck: "_healthcheck",
  telegramCallbackRoutes: "telegramCallbackRoutes",
} as const;

export { FieldValue, getFirestore, Timestamp };
