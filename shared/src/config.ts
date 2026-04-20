import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const hexKey = z
  .string()
  .length(64)
  .regex(/^[0-9a-fA-F]+$/);

const base64Key = z.string().refine((s) => {
  try {
    const buf = Buffer.from(s, "base64");
    return buf.length === 32;
  } catch {
    return false;
  }
}, "ENCRYPTION_KEY base64 must decode to 32 bytes");

const encryptionKeySchema = z.union([hexKey, base64Key]);

export const envSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().min(1),
  ENCRYPTION_KEY: encryptionKeySchema,
  SLACK_SIGNING_SECRET: z.string().min(1),
  /** Hermes / other tools; optional for this repo’s Node services (they do not call the LLM). */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Preferred when using Hermes with OpenRouter (see hermes/config.yaml `model`). */
  OPENROUTER_API_KEY: z.string().optional(),
  GUARDRAIL_PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  LEARNING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  HR_HERMES_ROOT: z.string().optional(),
  /** Required at runtime by `composio-gmail-mcp`; optional for other processes. */
  COMPOSIO_API_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  dryRun: boolean;
  learningEnabled: boolean;
  hrHermesRoot: string;
};

function findAndLoadEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
    resolve(process.cwd(), "..", "..", ".env"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      loadDotenv({ path: p });
      return;
    }
  }
  loadDotenv();
}

export function loadConfig(overrides?: Record<string, string | undefined>): AppConfig {
  findAndLoadEnv();
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  const e = parsed.data;
  return {
    ...e,
    dryRun: Boolean(e.DRY_RUN),
    learningEnabled: Boolean(e.LEARNING_ENABLED),
    hrHermesRoot: e.HR_HERMES_ROOT ?? process.cwd(),
  };
}
