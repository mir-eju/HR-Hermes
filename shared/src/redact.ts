import type { Project } from "./types.js";

export function redactProject(p: Project): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  const g = clone.gmail as Record<string, string>;
  if (g) {
    for (const k of Object.keys(g)) {
      if (k.endsWith("Encrypted")) g[k] = "[REDACTED]";
    }
    if (g.composioUserId) g.composioUserId = "[REDACTED]";
  }
  const t = clone.trello as Record<string, string>;
  if (t) {
    for (const k of Object.keys(t)) {
      if (k.endsWith("Encrypted")) t[k] = "[REDACTED]";
    }
  }
  const s = clone.slack as Record<string, string> | undefined;
  if (s) {
    for (const k of Object.keys(s)) {
      if (k.endsWith("Encrypted")) s[k] = "[REDACTED]";
    }
  }
  const tg = clone.telegram as Record<string, string> | undefined;
  if (tg) {
    for (const k of Object.keys(tg)) {
      if (k.endsWith("Encrypted")) tg[k] = "[REDACTED]";
    }
  }
  return clone;
}
