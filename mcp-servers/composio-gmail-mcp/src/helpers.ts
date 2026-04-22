const DETAIL_MAX = 3500;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Composio often throws Error with only a short message; pull cause, stack head,
 * and common enumerable fields so Firestore audit / lastPollError is actionable.
 */
export function formatComposioExecutionError(err: unknown): string {
  if (err instanceof Error) {
    const parts: string[] = [err.message || "(no message)"];
    if (err.stack) parts.push(truncate(err.stack.split("\n").slice(0, 6).join("\n"), 800));
    const c = err.cause;
    if (c !== undefined && c !== null) {
      parts.push(
        `cause: ${c instanceof Error ? truncate(c.message + (c.stack ? "\n" + c.stack.split("\n").slice(0, 3).join("\n") : ""), 1200) : truncate(String(c), 1200)}`
      );
    }
    const ex = err as Error & Record<string, unknown>;
    for (const k of ["code", "status", "statusCode", "body", "response", "data", "details", "meta"] as const) {
      const v = ex[k];
      if (v === undefined || v === null) continue;
      try {
        parts.push(`${k}: ${truncate(typeof v === "string" ? v : JSON.stringify(v), DETAIL_MAX)}`);
      } catch {
        parts.push(`${k}: ${truncate(String(v), 500)}`);
      }
    }
    return truncate(parts.join("\n\n"), 8000);
  }
  try {
    return truncate(JSON.stringify(err), DETAIL_MAX);
  } catch {
    return truncate(String(err), DETAIL_MAX);
  }
}

/**
 * Gmail `after:yyyy/m/d` for “today” in `GMAIL_POLL_TZ` (IANA), or the Node process local calendar if unset.
 */
function gmailCalendarDayForAfterClause(): string {
  const tz = process.env.GMAIL_POLL_TZ?.trim();
  const now = new Date();
  if (!tz) {
    return `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}/${m}/${d}`;
  } catch {
    /* invalid TZ — fall back */
  }
  return `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
}

/**
 * Extra Gmail search tokens for unread list (see `GMAIL_LIST_UNREAD_SCOPE` in `.env.example`).
 * Default `rolling1d` avoids calendar “today” mismatches vs server UTC vs mailbox TZ.
 */
function unreadListTimeClause(): string {
  const scope = (process.env.GMAIL_LIST_UNREAD_SCOPE || "rolling1d").trim().toLowerCase();
  if (scope === "none" || scope === "off") return "";
  if (scope === "calendar") {
    const day = gmailCalendarDayForAfterClause();
    return ` after:${day}`;
  }
  if (scope === "rolling7d") return " newer_than:7d";
  // rolling1d or unknown
  return " newer_than:1d";
}

/** Unread messages in inbox or `watchLabel`, with optional time window (default: last ~24h). */
export function buildListQuery(watchLabel: string): string {
  const label = watchLabel || "INBOX";
  const base = `is:unread${unreadListTimeClause()}`;
  if (label.toUpperCase() === "INBOX") {
    return `${base} in:inbox`;
  }
  return `${base} label:${label}`;
}

export function extractEmailFromFromHeader(from: string): string {
  const m = from.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  const t = from.trim();
  if (t.includes("@")) return t;
  return t;
}

/** Best-effort plain text from nested Gmail-like payload objects. */
export function extractPlainTextFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  if (p.mimeType === "text/plain" && typeof p.body === "object" && p.body) {
    const b = (p.body as { data?: string }).data;
    if (b) {
      try {
        return Buffer.from(String(b).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      } catch {
        return "";
      }
    }
  }
  if (Array.isArray(p.parts)) {
    for (const part of p.parts) {
      const t = extractPlainTextFromPayload(part);
      if (t) return t;
    }
  }
  return "";
}

export function headerMap(headers: { name?: string; value?: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers || []) {
    if (h.name && h.value) out[String(h.name).toLowerCase()] = String(h.value);
  }
  return out;
}

export function unwrapComposioData(result: unknown): unknown {
  if (result === null || result === undefined) return result;
  if (typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  const data = r.data ?? r.response ?? r.result;
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return data;
    }
  }
  return data;
}

/** Peel nested `{ data: { data: … } }` wrappers from tool execute / proxy payloads. */
function peelDataWrappers(node: unknown, maxDepth: number): unknown {
  let cur: unknown = node;
  for (let i = 0; i < maxDepth; i++) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) break;
    const o = cur as Record<string, unknown>;
    const inner = o.data ?? o.response ?? o.result;
    if (inner === undefined || inner === cur) break;
    if (typeof inner === "string") {
      try {
        cur = JSON.parse(inner) as unknown;
        continue;
      } catch {
        break;
      }
    }
    if (typeof inner === "object") {
      cur = inner;
      continue;
    }
    break;
  }
  return cur;
}

/** Unwrap + peel Composio `tools.execute` payload for diagnostics (same as first step of `normalizeMessages`). */
export function peekComposioListPayload(payload: unknown): unknown {
  return peelDataWrappers(unwrapComposioData(payload), 6);
}

function isMessageLike(x: unknown): boolean {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (o.payload && typeof o.payload === "object") return true;
  if (o.mimePayload && typeof o.mimePayload === "object") return true;
  if (o.messageId || o.message_id) return true;
  if (o.id && (o.threadId || o.thread_id)) return true;
  return false;
}

/** Normalize GMAIL_FETCH_EMAILS / list responses to an array of message-like objects. */
export function normalizeMessages(payload: unknown): Record<string, unknown>[] {
  const root = peelDataWrappers(unwrapComposioData(payload), 6);
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): Record<string, unknown>[] {
    if (depth > 12 || node === null || node === undefined) return [];
    if (typeof node !== "object") return [];

    if (typeof node === "object" && !Array.isArray(node)) {
      const obj = node as object;
      if (seen.has(obj)) return [];
      seen.add(obj);
    }

    if (Array.isArray(node)) {
      if (node.length === 0) return [];
      if (node.every((x) => isMessageLike(x))) {
        return node as Record<string, unknown>[];
      }
      const fromThreads: Record<string, unknown>[] = [];
      for (const el of node) {
        if (!el || typeof el !== "object") continue;
        const t = el as Record<string, unknown>;
        const msgs = t.messages ?? t.messageList ?? t.message_list;
        if (Array.isArray(msgs)) {
          fromThreads.push(...walk(msgs, depth + 1));
        }
      }
      if (fromThreads.length) return fromThreads;
      return [];
    }

    const o = node as Record<string, unknown>;
    if (isMessageLike(o) && (o.id || o.messageId || o.message_id || o.payload)) {
      return [o];
    }

    const arrayKeys = [
      "messages",
      "messageList",
      "message_list",
      "emails",
      "items",
      "results",
    ] as const;
    for (const k of arrayKeys) {
      const v = o[k];
      if (Array.isArray(v) && v.length) {
        const inner = walk(v, depth + 1);
        if (inner.length) return inner;
      }
    }

    for (const k of ["data", "response", "result", "body"] as const) {
      const v = o[k];
      if (v && typeof v === "object") {
        const inner = walk(v, depth + 1);
        if (inner.length) return inner;
      }
    }

    return [];
  }

  return walk(root, 0);
}

/** Shallow keys for MCP diagnostics when no messages parsed. */
export function responseShapeHint(parsed: unknown): { kind: string; keys: string[] } {
  if (parsed === null || parsed === undefined) return { kind: "null", keys: [] };
  if (Array.isArray(parsed)) return { kind: "array", keys: [`length:${parsed.length}`] };
  if (typeof parsed !== "object") return { kind: typeof parsed, keys: [] };
  const keys = Object.keys(parsed as object);
  return { kind: "object", keys: keys.slice(0, 48) };
}
