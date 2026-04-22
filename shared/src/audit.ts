import type { Firestore } from "firebase-admin/firestore";
import type { AuditKind, AuditLogEntry } from "./types.js";
import { collections, now } from "./firestore.js";

/** Firestore rejects `undefined` anywhere in a document; drop top-level undefined keys. */
function omitUndefinedTopLevel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

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
  await ref.set(omitUndefinedTopLevel(entry));
  return ref.id;
}
