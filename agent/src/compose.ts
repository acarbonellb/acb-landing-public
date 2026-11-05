// The production composition root: builds every dependency of the app from
// the configuration (`config.ts`). The only place that picks adapters; the
// router (`app.ts`) takes them all as given, and tests build theirs with
// `testAppDeps` (`test-deps.ts`).
import { createAnthropicModelClient } from "./anthropic";
import type { AppDeps } from "./app";
import { clientIp, mcpClientIp } from "./client-ip";
import type { Config } from "./config";
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { createFirestoreDocumentStore } from "./firestore";
import type { ModelClient } from "./model";
import { createMemoryRateLimiter, createStoreRateLimiter } from "./rate-limit";
import { createMemorySpendCap, createStoreSpendCap } from "./spend-cap";
import { createToolset, siteContent } from "./tools";
import { createUsageRecorder } from "./usage";

const minute = 60_000;

/** The shared store for the guardrails, or `null` to keep them in memory. */
export function createDocumentStore(store: Config["store"]): DocumentStore | null {
  return store.kind === "firestore" ? createFirestoreDocumentStore(store) : null;
}

/** The production model client, or `null` when no API key is set. */
function createModelClient(config: Config): ModelClient | null {
  if (!config.anthropicApiKey) return null;
  return createAnthropicModelClient({
    apiKey: config.anthropicApiKey,
    model: config.model,
    effort: config.effort,
  });
}

/**
 * The rate limits, spend cap and usage stats: all in the shared store when
 * one is configured, else all in memory, per instance.
 */
export function createGuardrails(
  store: DocumentStore | null,
  { guardrails }: Config,
): Pick<AppDeps, "chatRateLimiter" | "mcpRateLimiter" | "spendCap" | "usage"> {
  const { pricing } = guardrails;
  const spendCapOptions = { budgetUsd: guardrails.monthlyBudgetUsd, pricing };
  if (store) {
    const rateLimiter = (name: string, limit: number) =>
      createStoreRateLimiter({ store, name, limit, windowMs: minute });
    return {
      chatRateLimiter: rateLimiter("chat", guardrails.chatRequestsPerMinute),
      mcpRateLimiter: rateLimiter("mcp", guardrails.mcpRequestsPerMinute),
      spendCap: createStoreSpendCap({ ...spendCapOptions, store }),
      usage: createUsageRecorder({ store, pricing }),
    };
  }
  const rateLimiter = (limit: number) => createMemoryRateLimiter({ limit, windowMs: minute });
  return {
    chatRateLimiter: rateLimiter(guardrails.chatRequestsPerMinute),
    mcpRateLimiter: rateLimiter(guardrails.mcpRequestsPerMinute),
    spendCap: createMemorySpendCap(spendCapOptions),
    usage: createUsageRecorder({ store: createMemoryDocumentStore(), pricing }),
  };
}

/** Every dependency of the production app, built from the configuration. */
export function composeAppDeps(config: Config): AppDeps {
  return {
    toolset: createToolset({ ...siteContent, contactEmail: config.contactEmail }),
    modelClient: createModelClient(config),
    allowedOrigins: config.allowedOrigins,
    chatLimits: config.chatLimits,
    ...createGuardrails(createDocumentStore(config.store), config),
    rateLimitKey: clientIp,
    mcpRateLimitKey: mcpClientIp,
  };
}
