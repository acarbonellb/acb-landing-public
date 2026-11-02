// Runtime configuration, read from environment variables. No secrets live in
// the repo: the API key comes from the environment (Secret Manager in
// production, your shell locally).
import * as z from "zod";
import { createAnthropicModelClient, efforts } from "./anthropic";
import { chatLimits } from "./chat";
import type { ModelClient } from "./model";

const intFromEnv = z.coerce.number().int().positive();
const usdFromEnv = z.coerce.number().nonnegative();

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().min(1).default("claude-opus-5-5"),
  AGENT_EFFORT: z.enum(efforts).default("low"),
  AGENT_MAX_TOKENS: intFromEnv.default(chatLimits.maxTokens),
  AGENT_MAX_ITERATIONS: intFromEnv.default(chatLimits.maxIterations),
  AGENT_MAX_REQUEST_TOKENS: intFromEnv.default(chatLimits.maxRequestTokens),
  RATE_LIMIT_CHAT_PER_MINUTE: intFromEnv.default(10),
  RATE_LIMIT_MCP_PER_MINUTE: intFromEnv.default(60),
  MONTHLY_SPEND_CAP_USD: usdFromEnv.default(20),
  // Claude Opus 5.5 list prices; change them with AGENT_MODEL.
  AGENT_PRICE_INPUT_USD_PER_MTOK: usdFromEnv.default(4),
  AGENT_PRICE_OUTPUT_USD_PER_MTOK: usdFromEnv.default(20),
  // At least 1: 0 or less would make `clientIpFrom` read no proxy entry.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).default(1),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000,https://albertocarbonell.dev")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
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
      /** Proxies that append to X-Forwarded-For (Cloud Run: 1). */
      trustedProxyHops: e.TRUSTED_PROXY_HOPS,
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
