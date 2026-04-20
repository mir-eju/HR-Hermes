import type { Firestore } from "firebase-admin/firestore";
import type { AuditKind, AuditLogEntry } from "./types.js";
import { collections, now } from "./firestore.js";

export async function writeAuditLog(
  db: Firestore,
  kind: AuditKind,
  payload: Omit<AuditLogEntry, "at" | "kind"> & { kind?: AuditKind }
): Promise<string> {
  const ref = db.collection(collections.auditLog).doc();
  const entry: Record<string, unknown> = {
    id: ref.id,
    at: now(),
    kind,
    ...payload,
  };
  await ref.set(entry);
  return ref.id;
}
