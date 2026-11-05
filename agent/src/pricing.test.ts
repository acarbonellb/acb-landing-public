import { describe, expect, it } from "vitest";
import { listPrices, resolvePricing, usageCostUsd } from "./pricing";

const pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };

describe("usageCostUsd", () => {
  it("prices input and output tokens per million", () => {
    expect(usageCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, pricing)).toBe(4);
    expect(usageCostUsd({ inputTokens: 500_000, outputTokens: 100_000 }, pricing)).toBe(4);
  });

  it("prices cache writes at 1.25x the input price, not as base input", () => {
    // 1M input tokens, all of them written to the cache: $4 × 1.25.
    const written = { inputTokens: 1_000_000, outputTokens: 0, cacheWriteInputTokens: 1_000_000 };
    expect(usageCostUsd(written, pricing)).toBe(5);
    // Half written, half plain input: $2.50 + $2.
    expect(usageCostUsd({ ...written, cacheWriteInputTokens: 500_000 }, pricing)).toBe(4.5);
  });

  it("prices cache reads at 0.1x the input price unless the model has its own", () => {
    const read = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 1_000_000 };
    expect(usageCostUsd(read, pricing)).toBeCloseTo(0.4, 12);
    expect(usageCostUsd(read, { ...pricing, cacheReadUsdPerMTok: 0.2 })).toBeCloseTo(0.2, 12);
  });
});

describe("listPrices", () => {
  it("holds the list prices of Claude Haiku 5.5 (prompts up to 100K tokens) and Sonnet 5.5", () => {
    expect(listPrices["claude-haiku-5-5"]).toEqual({ inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 });
    expect(listPrices["claude-sonnet-5-5"]).toEqual({
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheReadUsdPerMTok: 0.1,
    });
  });
});

describe("resolvePricing", () => {
  it("follows the model: its list prices by default", () => {
    expect(resolvePricing("claude-haiku-5-5", {})).toEqual({
      inputUsdPerMTok: 0.1,
      outputUsdPerMTok: 0.5,
    });
    expect(resolvePricing("claude-opus-5-5", {})).toEqual({
      inputUsdPerMTok: 4,
      outputUsdPerMTok: 20,
      cacheReadUsdPerMTok: 0.2,
    });
  });

  it("takes explicit prices over the list; a new input price drops the model's cache-read price", () => {
    expect(resolvePricing("claude-haiku-5-5", { inputUsdPerMTok: 2, outputUsdPerMTok: 10 })).toEqual({
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
    });
    expect(resolvePricing("claude-sonnet-5-5", { outputUsdPerMTok: 12 })).toEqual({
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 12,
      cacheReadUsdPerMTok: 0.1,
    });
    expect(resolvePricing("claude-sonnet-5-5", { inputUsdPerMTok: 3 })).toEqual({
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 10,
    });
  });

  it("prices a model missing from the list only with both explicit prices", () => {
    expect(resolvePricing("claude-future-9", { inputUsdPerMTok: 1, outputUsdPerMTok: 5 })).toEqual({
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 5,
    });
    expect(() => resolvePricing("claude-future-9", {})).toThrow(/claude-future-9/);
    expect(() => resolvePricing("claude-future-9", { inputUsdPerMTok: 1 })).toThrow(/claude-future-9/);
  });
});
