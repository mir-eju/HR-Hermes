export function buildListQuery(watchLabel: string): string {
  const label = watchLabel || "INBOX";
  if (label.toUpperCase() === "INBOX") {
    return "is:unread in:inbox";
  }
  return `is:unread label:${label}`;
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

/** Normalize GMAIL_FETCH_EMAILS / list responses to an array of message-like objects. */
export function normalizeMessages(payload: unknown): Record<string, unknown>[] {
  const root = unwrapComposioData(payload);
  if (!root) return [];
  if (Array.isArray(root)) return root as Record<string, unknown>[];
  if (typeof root === "object") {
    const o = root as Record<string, unknown>;
    const candidates = [o.messages, o.messageList, o.items, o.emails, o.data];
    for (const c of candidates) {
      if (Array.isArray(c)) return c as Record<string, unknown>[];
    }
    if (o.messageId || o.id) return [o];
  }
  return [];
}
