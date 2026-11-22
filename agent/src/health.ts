// The deep health check behind `/health?deep=1`: what the post-deploy smoke
// check asks a candidate revision before it takes traffic
// (docs/chat-contract.md, "Health check"). `/health` itself is liveness only.
import type { Config } from "./config";
import type { DocumentStore } from "./document-store";
import { logEvent, logStoreError } from "./log";
import { createMemoryRateLimiter, type RateLimiter } from "./rate-limit";

/**
 * Deep checks allowed per minute, from all clients together: each reads the
 * store, so this bounds what the public route can cost. In memory, per
 * instance, so a candidate revision has its own window.
 */
export const deepHealthChecksPerMinute = 10;

/** The deep check's rate limit: one window for every client (key it with `globalKey`). */
export const createDeepHealthRateLimiter = (): RateLimiter =>
  createMemoryRateLimiter({ limit: deepHealthChecksPerMinute, windowMs: 60_000 });

/** The document the check reads. Never written: a missing document is a good answer. */
export const healthProbePath = "health/probe";

export type DeepHealthReport = { healthy: true } | { healthy: false };

export interface DeepHealthCheck {
  /** Never throws: a failure is an unhealthy report, logged with its reason. */
  check(): Promise<DeepHealthReport>;
}

type RequiredConfig = Pick<Config, "anthropicApiKey" | "contactEmail" | "answerSigningKey">;

/**
 * The settings production needs that the agent can start without: each one's
 * variable and whether it's set. Without them the chat answers 503, the
 * contact has no address, or each instance signs with its own key.
 */
const requiredConfig = (config: RequiredConfig) => ({
  ANTHROPIC_API_KEY: Boolean(config.anthropicApiKey),
  CONTACT_EMAIL: Boolean(config.contactEmail),
  ANSWER_SIGNING_KEY: Boolean(config.answerSigningKey),
});

export function createDeepHealthCheck({
  store,
  config,
}: {
  store: DocumentStore;
  config: RequiredConfig;
}): DeepHealthCheck {
  // The configuration is fixed for the process, so this is worked out once.
  const missing = Object.entries(requiredConfig(config))
    .filter(([, set]) => !set)
    .map(([name]) => name);
  return {
    async check() {
      if (missing.length) {
        // Names only, never a value.
        logEvent("ERROR", "config_missing", "Deep health check: required configuration is missing", {
          missing: missing.join(","),
        });
        return { healthy: false };
      }
      try {
        // One read, no write: the change returns no document.
        await store.update(healthProbePath, () => ({ result: undefined }));
      } catch (error) {
        logStoreError("health_check", "Deep health check: the store failed", error);
        return { healthy: false };
      }
      return { healthy: true };
    },
  };
}
