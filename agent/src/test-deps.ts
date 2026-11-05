// App dependencies for tests: the memory adapters and the fake model, with the
// same limits production has by default, whatever the shell's environment.
// The guardrails are wired by the composition root, as in production with no
// shared store.
import type { AppDeps } from "./app";
import { mcpRateLimitKey, mcpUnknownGoogleHop, rateLimitKey } from "./client-ip";
import { createGuardrails } from "./compose";
import { loadConfig } from "./config";
import { createFakeModel } from "./fake-model";
import { createToolset } from "./tools";

/** The configuration with no environment: the code defaults. */
const defaults = loadConfig({});

/**
 * Every dependency in memory, with a fake model that has nothing scripted;
 * `overrides` replace any of them.
 */
export function testAppDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    toolset: createToolset(),
    modelClient: createFakeModel([]),
    allowedOrigins: defaults.allowedOrigins,
    chatLimits: defaults.chatLimits,
    ...createGuardrails(null, defaults),
    rateLimitKey,
    mcpRateLimitKey,
    isUnknownGoogleHop: mcpUnknownGoogleHop,
    ...overrides,
  };
}
