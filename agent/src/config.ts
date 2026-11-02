// Runtime configuration, read from environment variables. No secrets live in
// the repo: the API key comes from the environment (Secret Manager in
// production, your shell locally).
import * as z from "zod";
import { createAnthropicModelClient, efforts } from "./anthropic";
import { chatLimits } from "./chat";
import type { ModelClient } from "./model";

const intFromEnv = z.coerce.number().int().positive();

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().min(1).default("claude-opus-5-5"),
  AGENT_EFFORT: z.enum(efforts).default("low"),
  AGENT_MAX_TOKENS: intFromEnv.default(chatLimits.maxTokens),
  AGENT_MAX_ITERATIONS: intFromEnv.default(chatLimits.maxIterations),
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
    chatLimits: { maxIterations: e.AGENT_MAX_ITERATIONS, maxTokens: e.AGENT_MAX_TOKENS },
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
