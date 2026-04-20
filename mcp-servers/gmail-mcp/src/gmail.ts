import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import type { Project } from "@hr-hermes/shared";
import { decrypt } from "@hr-hermes/shared";

export function gmailClientForProject(project: Project, encryptionKey: string) {
  const oauth2Client = new google.auth.OAuth2(
    decrypt(project.gmail.clientIdEncrypted, encryptionKey),
    decrypt(project.gmail.clientSecretEncrypted, encryptionKey)
  );
  oauth2Client.setCredentials({
    refresh_token: decrypt(project.gmail.refreshTokenEncrypted, encryptionKey),
  });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

export function buildListQuery(watchLabel: string): string {
  const label = watchLabel || "INBOX";
  if (label.toUpperCase() === "INBOX") {
    return "is:unread in:inbox";
  }
  return `is:unread label:${label}`;
}

export function extractPlainTextFromPayload(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = extractPlainTextFromPayload(p);
      if (t) return t;
    }
  }
  return "";
}

export function headerMap(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers || []) {
    if (h.name && h.value) out[h.name.toLowerCase()] = h.value;
  }
  return out;
}
