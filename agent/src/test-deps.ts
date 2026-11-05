// App dependencies for tests: the memory adapters and the fake model, with the
// same limits production has by default, whatever the shell's environment.
import type { AppDeps } from "./app";
import { clientIp, mcpClientIp } from "./client-ip";
import { loadConfig } from "./config";
import { createMemoryDocumentStore } from "./document-store";
import { createFakeModel } from "./fake-model";
import { createMemoryRateLimiter } from "./rate-limit";
import { createMemorySpendCap } from "./spend-cap";
import { createToolset } from "./tools";
import { createUsageRecorder } from "./usage";

/** The configuration with no environment: the code defaults. */
const defaults = loadConfig({});
const minute = 60_000;

/**
 * Every dependency in memory, with a fake model that has nothing scripted;
 * `overrides` replace any of them.
 */
export function testAppDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const { guardrails } = defaults;
  const { pricing } = guardrails;
  return {
    toolset: createToolset(),
    modelClient: createFakeModel([]),
    allowedOrigins: defaults.allowedOrigins,
    chatLimits: defaults.chatLimits,
    chatRateLimiter: createMemoryRateLimiter({
      limit: guardrails.chatRequestsPerMinute,
      windowMs: minute,
    }),
    mcpRateLimiter: createMemoryRateLimiter({
      limit: guardrails.mcpRequestsPerMinute,
      windowMs: minute,
    }),
    spendCap: createMemorySpendCap({ budgetUsd: guardrails.monthlyBudgetUsd, pricing }),
    usage: createUsageRecorder({ store: createMemoryDocumentStore(), pricing }),
    clientKey: clientIp,
    mcpClientKey: mcpClientIp,
    ...overrides,
  };
}
