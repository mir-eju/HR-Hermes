import { createHmac, timingSafeEqual } from "node:crypto";
export function verifySlackRequest(opts: {
  signingSecret: string;
  requestTimestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
}): void {
  const ts = opts.requestTimestamp;
  const sig = opts.signature;
  if (!ts || !sig) throw new Error("Missing Slack signature headers");
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (Number.isNaN(age) || age > 60 * 5) {
    throw new Error("Stale Slack request");
  }
  const base = `v0:${ts}:${opts.rawBody.toString()}`;
  const hmac = createHmac("sha256", opts.signingSecret).update(base, "utf8").digest("hex");
  const expected = `v0=${hmac}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Bad Slack signature");
  }
}
