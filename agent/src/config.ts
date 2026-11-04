// Runtime configuration, read from environment variables. No secrets live in
// the repo: the API key comes from the environment (Secret Manager in
// production, your shell locally).
import * as z from "zod";
import { createAnthropicModelClient, efforts } from "./anthropic";
import { chatLimits } from "./chat";
import type { DocumentStore } from "./document-store";
import { createFirestoreDocumentStore } from "./firestore";
import type { ModelClient } from "./model";

const intFromEnv = z.coerce.number().int().positive();
const usdFromEnv = z.coerce.number().nonnegative();

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  AGENT_EFFORT: z.enum(efforts).default("low"),
  AGENT_MAX_TOKENS: intFromEnv.default(chatLimits.maxTokens),
  AGENT_MAX_ITERATIONS: intFromEnv.default(chatLimits.maxIterations),
  AGENT_MAX_REQUEST_TOKENS: intFromEnv.default(chatLimits.maxRequestTokens),
  RATE_LIMIT_CHAT_PER_MINUTE: intFromEnv.default(10),
  RATE_LIMIT_MCP_PER_MINUTE: intFromEnv.default(60),
  MONTHLY_SPEND_CAP_USD: usdFromEnv.default(20),
  // Claude Haiku 5.5 list prices (prompts up to 100K tokens, far above a
  // chat request); change them with AGENT_MODEL.
  AGENT_PRICE_INPUT_USD_PER_MTOK: usdFromEnv.default(0.1),
  AGENT_PRICE_OUTPUT_USD_PER_MTOK: usdFromEnv.default(0.5),
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
}).refine((e) => e.AGENT_STORE !== "firestore" || e.FIRESTORE_PROJECT_ID, {
  message: "required when AGENT_STORE is firestore",
  path: ["FIRESTORE_PROJECT_ID"],
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
    model: e.AGENT_MODEL,
    effort: e.AGENT_EFFORT,
    allowedOrigins: e.ALLOWED_ORIGINS,
    chatLimits: {
      maxIterations: e.AGENT_MAX_ITERATIONS,
      maxTokens: e.AGENT_MAX_TOKENS,
      maxRequestTokens: e.AGENT_MAX_REQUEST_TOKENS,
    },
    guardrails: {
      chatRequestsPerMinute: e.RATE_LIMIT_CHAT_PER_MINUTE,
      mcpRequestsPerMinute: e.RATE_LIMIT_MCP_PER_MINUTE,
      monthlyBudgetUsd: e.MONTHLY_SPEND_CAP_USD,
      pricing: {
        inputUsdPerMTok: e.AGENT_PRICE_INPUT_USD_PER_MTOK,
        outputUsdPerMTok: e.AGENT_PRICE_OUTPUT_USD_PER_MTOK,
      },
    },
    store,
    /** The shared store for the guardrails, or `null` to keep them in memory. */
    createDocumentStore(): DocumentStore | null {
      return store.kind === "firestore" ? createFirestoreDocumentStore(store) : null;
    },
    /** The production model client, or `null` when no API key is set. */
    createModelClient(): ModelClient | null {
      if (!e.ANTHROPIC_API_KEY) return null;
      return createAnthropicModelClient({
        apiKey: e.ANTHROPIC_API_KEY,
        model: e.AGENT_MODEL,
        effort: e.AGENT_EFFORT,
      });
    },
  };
}
