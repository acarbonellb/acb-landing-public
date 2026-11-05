// Runtime configuration, read from environment variables. No secrets live in
// the repo: the API key and the contact email come from the environment
// (Secret Manager in production, your shell locally). Plain data only: the
// production composer (`compose.ts`) builds the adapters from it.
import * as z from "zod";
import { chatLimits } from "./chat";
import { efforts } from "./model";
import { resolvePricing } from "./pricing";

const defaultModel = "claude-haiku-5-5";

const intFromEnv = z.coerce.number().int().positive();
const usdFromEnv = z.coerce.number().nonnegative();

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  // The address get_contact gives out. Secret Manager in production, never
  // the repo; unset, the tools offer LinkedIn and GitHub only. Trimmed first:
  // a secret saved with a trailing newline must not stop the service starting.
  CONTACT_EMAIL: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    z.email().optional(),
  ),
  // Signs the chat's answers (answer-signing.ts). Secret Manager in
  // production, where it is required; unset elsewhere, each process makes
  // its own. Trimmed like the email.
  ANSWER_SIGNING_KEY: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    z.string().min(32, "must be at least 32 characters").optional(),
  ),
  AGENT_MODEL: z.string().min(1).default(defaultModel),
  AGENT_EFFORT: z.enum(efforts).default("low"),
  AGENT_MAX_TOKENS: intFromEnv.default(chatLimits.maxTokens),
  AGENT_MAX_ITERATIONS: intFromEnv.default(chatLimits.maxModelCalls),
  AGENT_MAX_REQUEST_TOKENS: intFromEnv.default(chatLimits.maxRequestTokens),
  RATE_LIMIT_CHAT_PER_MINUTE: intFromEnv.default(10),
  RATE_LIMIT_MCP_PER_MINUTE: intFromEnv.default(60),
  // Global ceilings, all keys together, so rotating keys can't multiply what
  // one source gets. Sized well above the per-IP limits and /stats traffic.
  RATE_LIMIT_CHAT_GLOBAL_PER_MINUTE: intFromEnv.default(60),
  RATE_LIMIT_MCP_GLOBAL_PER_MINUTE: intFromEnv.default(600),
  // Under the $5/month hard limit set on the Anthropic workspace, so this
  // cap (and its "budget reached" message) is what the visitor meets first.
  MONTHLY_SPEND_CAP_USD: usdFromEnv.default(4),
  // Per rate-limit key and UTC day. /stats measured about $0.0004 per answer
  // (W45), so this is ~250 short answers, or a few dozen long conversations,
  // and still fits a maximal request's worst case (~$0.02 on the default
  // model). Forty keys a day are needed to spend the month's cap.
  DAILY_SPEND_QUOTA_USD: usdFromEnv.default(0.1),
  // Unset, AGENT_MODEL's list prices (pricing.ts); required for a model
  // missing from that list.
  AGENT_PRICE_INPUT_USD_PER_MTOK: usdFromEnv.optional(),
  AGENT_PRICE_OUTPUT_USD_PER_MTOK: usdFromEnv.optional(),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000,https://albertocarbonell.dev")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  // Where the rate limits and spend cap keep their state: `memory` (per
  // instance, lost on restart; local development) or `firestore` (shared).
  AGENT_STORE: z.enum(["memory", "firestore"]).default("memory"),
  FIRESTORE_PROJECT_ID: z.string().optional(),
  FIRESTORE_DATABASE: z.string().min(1).default("(default)"),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  // The image sets NODE_ENV=production (agent/Dockerfile). There, scaled to
  // zero, the memory store would start the month's spend again at $0 on every
  // cold start, so it needs this explicit override.
  NODE_ENV: z.string().optional(),
  AGENT_ALLOW_MEMORY_STORE: z.enum(["true", "false"]).default("false"),
}).refine((e) => e.AGENT_STORE !== "firestore" || e.FIRESTORE_PROJECT_ID, {
  message: "required when AGENT_STORE is firestore",
  path: ["FIRESTORE_PROJECT_ID"],
}).refine(
  (e) =>
    e.NODE_ENV !== "production" ||
    e.AGENT_STORE !== "memory" ||
    e.AGENT_ALLOW_MEMORY_STORE === "true",
  {
    message:
      "AGENT_STORE is memory in production: the spend cap and rate limits would reset on every cold start. " +
      "Set AGENT_STORE=firestore, or AGENT_ALLOW_MEMORY_STORE=true to accept that",
    path: ["AGENT_STORE"],
  },
).refine((e) => e.NODE_ENV !== "production" || e.ANSWER_SIGNING_KEY, {
  // Each instance would sign with its own key, so answers from one would be
  // refused by the next after a cold start or a deploy.
  message: "required in production, where every instance must sign answers with the same key",
  path: ["ANSWER_SIGNING_KEY"],
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")),
  );
  if (!parsed.success) {
    throw new Error(`Invalid agent configuration: ${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  let pricing;
  try {
    pricing = resolvePricing(e.AGENT_MODEL, {
      inputUsdPerMTok: e.AGENT_PRICE_INPUT_USD_PER_MTOK,
      outputUsdPerMTok: e.AGENT_PRICE_OUTPUT_USD_PER_MTOK,
    });
  } catch (error) {
    throw new Error(`Invalid agent configuration: ${(error as Error).message}`);
  }
  const store =
    e.AGENT_STORE === "firestore"
      ? {
          kind: "firestore" as const,
          projectId: e.FIRESTORE_PROJECT_ID!,
          databaseId: e.FIRESTORE_DATABASE,
          emulatorHost: e.FIRESTORE_EMULATOR_HOST,
        }
      : { kind: "memory" as const };
  return {
    /** The model provider's key; unset, there is no model and the chat answers 503. */
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    model: e.AGENT_MODEL,
    contactEmail: e.CONTACT_EMAIL,
    /** Signs the chat's answers; unset (never in production), each process makes its own. */
    answerSigningKey: e.ANSWER_SIGNING_KEY,
    effort: e.AGENT_EFFORT,
    allowedOrigins: e.ALLOWED_ORIGINS,
    chatLimits: {
      maxModelCalls: e.AGENT_MAX_ITERATIONS,
      maxTokens: e.AGENT_MAX_TOKENS,
      maxRequestTokens: e.AGENT_MAX_REQUEST_TOKENS,
    },
    guardrails: {
      chatRequestsPerMinute: e.RATE_LIMIT_CHAT_PER_MINUTE,
      mcpRequestsPerMinute: e.RATE_LIMIT_MCP_PER_MINUTE,
      chatGlobalRequestsPerMinute: e.RATE_LIMIT_CHAT_GLOBAL_PER_MINUTE,
      mcpGlobalRequestsPerMinute: e.RATE_LIMIT_MCP_GLOBAL_PER_MINUTE,
      monthlyBudgetUsd: e.MONTHLY_SPEND_CAP_USD,
      dailyQuotaUsd: e.DAILY_SPEND_QUOTA_USD,
      pricing,
    },
    store,
  };
}
