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
import { createDeepHealthCheck, createDeepHealthRateLimiter } from "./health";
import type { ModelClient } from "./model";
import { createProviderLimitWatch } from "./provider-limit";
import { createMemoryRateLimiter, withGlobalCeiling } from "./rate-limit";
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
 * The rate limits, daily quota, spend cap and usage stats. The rate limits
 * (per-key windows and global ceilings) are always in this process: the
 * deploy runs one instance (ADR 0003, amendment). The daily quota, spend cap
 * and usage stats are in the shared store when one is configured, else in
 * memory too.
 */
export function createGuardrails(
  sharedStore: DocumentStore | null,
  { guardrails, alerts }: Config,
): Pick<
  AppDeps,
  "chatRateLimiter" | "mcpRateLimiter" | "statsRateLimiter" | "spendCap" | "dailyQuota" | "usage" | "providerLimit"
> {
  const { pricing } = guardrails;
  const shared = sharedStore && withStoreHealthEvents(sharedStore);
  // Without a shared store every durable guardrail keeps its documents in
  // this process: the same code over a memory store.
  const store = shared ?? createMemoryDocumentStore();
  // A per-key window of `perKey` requests a minute under a global ceiling of
  // `global`, both in memory.
  const rateLimiter = (perKey: number, global: number) =>
    withGlobalCeiling(
      createMemoryRateLimiter({ limit: perKey, windowMs: minute }),
      createMemoryRateLimiter({ limit: global, windowMs: minute }),
    );
  return {
    chatRateLimiter: rateLimiter(
      guardrails.chatRequestsPerMinute,
      guardrails.chatGlobalRequestsPerMinute,
    ),
    mcpRateLimiter: rateLimiter(
      guardrails.mcpRequestsPerMinute,
      guardrails.mcpGlobalRequestsPerMinute,
    ),
    statsRateLimiter: rateLimiter(
      guardrails.statsRequestsPerMinute,
      guardrails.statsGlobalRequestsPerMinute,
    ),
    spendCap: createStoreSpendCap({ store, capUsd: guardrails.monthlySpendCapUsd, pricing }),
    dailyQuota: createStoreDailyQuota({ store, quotaUsd: guardrails.dailyQuotaUsd, pricing }),
    usage: createUsageRecorder({ store, pricing, errorRateAlert: alerts.chatErrorRate }),
    providerLimit: createProviderLimitWatch({ store }),
  };
}

/** Every dependency of the production app, built from the configuration. */
export function composeAppDeps(config: Config): AppDeps {
  const sharedStore = createDocumentStore(config.store);
  return {
    toolset: createToolset({ ...siteContent, contactEmail: config.contactEmail }),
    modelClient: createModelClient(config),
    allowedOrigins: config.allowedOrigins,
    chatLimits: config.chatLimits,
    answerSigner: createAnswerSigner(config.answerSigningKey ?? ephemeralSigningKey()),
    ...createGuardrails(sharedStore, config),
    rateLimitKey,
    mcpRateLimitKey,
    isUnknownGoogleHop: mcpUnknownGoogleHop,
    // The guardrails' store; with none shared, a memory one, which always answers.
    deepHealth: createDeepHealthCheck({ store: sharedStore ?? createMemoryDocumentStore(), config }),
    deepHealthRateLimiter: createDeepHealthRateLimiter(),
  };
}
