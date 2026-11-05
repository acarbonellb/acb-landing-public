// Model prices and the cost of a usage: shared by the spend cap, the usage
// stats and the eval report. Source: Anthropic's pricing page,
// https://platform.claude.com/docs/en/about-claude/pricing (checked
// 2026-11-05). Update the table when a price changes there.
import type { Usage } from "./model";

/** USD per million tokens. */
export type Pricing = {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /**
   * Cache hits, when the model doesn't use the standard 0.1x of the input
   * price. Cache writes (5-minute cache, the only one used) are 1.25x the
   * input price on every model.
   */
  cacheReadUsdPerMTok?: number;
};

const cacheWriteMultiplier = 1.25;
const cacheReadMultiplier = 0.1;

/**
 * List prices of the Claude models the agent may run on (`AGENT_MODEL`):
 * the spend cap's and usage stats' default prices, and the eval report's cost
 * per case. Claude Haiku 5.5 at its price for prompts up to 100K tokens, far
 * above a chat request.
 */
export const listPrices: Readonly<Record<string, Pricing>> = {
  "claude-haiku-5-5": { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
  "claude-sonnet-5-5": { inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.1 },
  "claude-opus-5-5": { inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2 },
  "claude-opus-5": { inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  "claude-fable-5-1": { inputUsdPerMTok: 10, outputUsdPerMTok: 50, cacheReadUsdPerMTok: 0.25 },
  "claude-fable-5": { inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
};

/**
 * Models with server-side refusal fallbacks (`fallbacks: "default"`), on the
 * Claude API: https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
 * (Claude Haiku 5.5, the default model, has none). Kept by hand next to the
 * prices because both change with the model lineup: only these models get the
 * beta, so the default model's request carries nothing it doesn't use. A
 * fallback answer is billed at the fallback model's prices, which the spend
 * cap doesn't see; the recommended fallbacks are less capable models.
 */
export const serverSideFallbackModels: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-sonnet-5-5",
]);

/** Explicit prices (`AGENT_PRICE_*`), each overriding the model's list price. */
export type PriceOverrides = { inputUsdPerMTok?: number; outputUsdPerMTok?: number };

/**
 * The prices to charge `model` at: its list prices, overridden by any explicit
 * one. A model missing from the list needs both explicit prices; a new input
 * price drops the model's own cache-read price (back to the standard 0.1x).
 */
export function resolvePricing(model: string, overrides: PriceOverrides): Pricing {
  const list = listPrices[model];
  const { inputUsdPerMTok, outputUsdPerMTok } = overrides;
  if (inputUsdPerMTok === undefined && outputUsdPerMTok === undefined && list) return list;
  const input = inputUsdPerMTok ?? list?.inputUsdPerMTok;
  const output = outputUsdPerMTok ?? list?.outputUsdPerMTok;
  if (input === undefined || output === undefined) {
    throw new Error(
      `No list price for ${model}: set AGENT_PRICE_INPUT_USD_PER_MTOK and AGENT_PRICE_OUTPUT_USD_PER_MTOK`,
    );
  }
  const cacheRead = inputUsdPerMTok === undefined ? list?.cacheReadUsdPerMTok : undefined;
  return {
    inputUsdPerMTok: input,
    outputUsdPerMTok: output,
    ...(cacheRead !== undefined && { cacheReadUsdPerMTok: cacheRead }),
  };
}

export function usageCostUsd(usage: Usage, pricing: Pricing): number {
  const written = usage.cacheWriteInputTokens ?? 0;
  const read = usage.cacheReadInputTokens ?? 0;
  const input = pricing.inputUsdPerMTok;
  const cacheRead = pricing.cacheReadUsdPerMTok ?? input * cacheReadMultiplier;
  return (
    ((usage.inputTokens - written - read) * input +
      written * input * cacheWriteMultiplier +
      read * cacheRead +
      usage.outputTokens * pricing.outputUsdPerMTok) /
    1_000_000
  );
}

/** Adds `usage` to `total` in place, cache fields only when there are any. */
export function addUsage(total: Usage, usage: Usage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  if (usage.cacheWriteInputTokens) {
    total.cacheWriteInputTokens = (total.cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens;
  }
  if (usage.cacheReadInputTokens) {
    total.cacheReadInputTokens = (total.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
  }
}
