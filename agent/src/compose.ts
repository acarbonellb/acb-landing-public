// The production composition root: builds every dependency of the app from
// the configuration (`config.ts`). The only place that picks adapters; the
// router (`app.ts`) takes them all as given, and tests build theirs with
// `testAppDeps` (`test-deps.ts`).
import { createAnswerSigner, ephemeralSigningKey } from "./answer-signing";
import { createAnthropicModelClient } from "./anthropic";
import { createStoreDailyQuota } from "./daily-quota";
import type { AppDeps } from "./app";
import { mcpRateLimitKey, mcpUnknownGoogleHop, rateLimitKey } from "./client-ip";
import type { Config } from "./config";
import { createMemoryDocumentStore, withStoreHealthEvents, type DocumentStore } from "./document-store";
import { createFirestoreDocumentStore } from "./firestore";
import type { ModelClient } from "./model";
import { createProviderLimitWatch } from "./provider-limit";
import {
  createMemoryRateLimiter,
  createStoreRateLimiter,
  withGlobalCeiling,
  withRefusalCache,
  type RateLimiter,
} from "./rate-limit";
import { createStoreSpendCap } from "./spend-cap";
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
 * The rate limits, daily quota, spend cap and usage stats: all in the shared store when
 * one is configured, else all in memory, per instance.
 */
export function createGuardrails(
  sharedStore: DocumentStore | null,
  { guardrails, alerts }: Config,
): Pick<
  AppDeps,
  "chatRateLimiter" | "mcpRateLimiter" | "spendCap" | "dailyQuota" | "usage" | "providerLimit"
> {
  const { pricing } = guardrails;
  const shared = sharedStore && withStoreHealthEvents(sharedStore);
  // Without a shared store every guardrail keeps its documents in this
  // process: the same code over a memory store.
  const store = shared ?? createMemoryDocumentStore();
  // One window of `limit` requests per minute, the only part that differs.
  // Over the shared store, each window's refusals are also remembered
  // locally, so a flood that is already refused costs no store reads; the
  // ceiling's window is `rateLimits/<name>:*`.
  const window: (name: string, limit: number) => RateLimiter = shared
    ? (name, limit) =>
        withRefusalCache(createStoreRateLimiter({ store: shared, name, limit, windowMs: minute }))
    : (_name, limit) => createMemoryRateLimiter({ limit, windowMs: minute });
  const rateLimiter = (name: string, perKey: number, global: number) =>
    withGlobalCeiling(window(name, perKey), window(name, global));
  return {
    chatRateLimiter: rateLimiter(
      "chat",
      guardrails.chatRequestsPerMinute,
      guardrails.chatGlobalRequestsPerMinute,
    ),
    mcpRateLimiter: rateLimiter(
      "mcp",
      guardrails.mcpRequestsPerMinute,
      guardrails.mcpGlobalRequestsPerMinute,
    ),
    spendCap: createStoreSpendCap({ store, capUsd: guardrails.monthlySpendCapUsd, pricing }),
    dailyQuota: createStoreDailyQuota({ store, quotaUsd: guardrails.dailyQuotaUsd, pricing }),
    usage: createUsageRecorder({ store, pricing, errorRateAlert: alerts.chatErrorRate }),
    providerLimit: createProviderLimitWatch({ store }),
  };
}

/** Every dependency of the production app, built from the configuration. */
export function composeAppDeps(config: Config): AppDeps {
  return {
    toolset: createToolset({ ...siteContent, contactEmail: config.contactEmail }),
    modelClient: createModelClient(config),
    allowedOrigins: config.allowedOrigins,
    chatLimits: config.chatLimits,
    answerSigner: createAnswerSigner(config.answerSigningKey ?? ephemeralSigningKey()),
    ...createGuardrails(createDocumentStore(config.store), config),
    rateLimitKey,
    mcpRateLimitKey,
    isUnknownGoogleHop: mcpUnknownGoogleHop,
  };
}
