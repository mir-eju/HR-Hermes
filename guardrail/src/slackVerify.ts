import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackRequest(opts: {
  signingSecret: string;
  requestTimestamp: string;
  signature: string;
  rawBody: Buffer;
}): void {
  const { signingSecret, requestTimestamp, signature, rawBody } = opts;
  const ts = requestTimestamp;
  const sig = signature;
  if (!ts || !sig) throw new Error("Missing Slack signature headers");
  const ageSec = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(ageSec) || ageSec > 60 * 5) {
    throw new Error("Stale Slack request");
  }
  const base = `v0:${ts}:${rawBody.toString("utf8")}`;
  const hmac = createHmac("sha256", signingSecret).update(base, "utf8").digest("hex");
  const expected = `v0=${hmac}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Bad Slack signature");
  }
}
