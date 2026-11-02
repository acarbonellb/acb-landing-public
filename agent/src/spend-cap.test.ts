import { describe, expect, it } from "vitest";
import { createMemorySpendCap, usageCostUsd } from "./spend-cap";

const pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };

function fakeClock(iso: string) {
  let now = Date.parse(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = Date.parse(next);
    },
  };
}

describe("usageCostUsd", () => {
  it("prices input and output tokens per million", () => {
    expect(usageCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, pricing)).toBe(4);
    expect(usageCostUsd({ inputTokens: 500_000, outputTokens: 100_000 }, pricing)).toBe(4);
  });
});

describe("createMemorySpendCap", () => {
  it("is open until the month's spend reaches the budget", async () => {
    const clock = fakeClock("2026-11-02T12:00:00Z");
    const cap = createMemorySpendCap({ budgetUsd: 10, pricing, now: clock.now });

    expect(await cap.check()).toEqual({ exhausted: false });
    await cap.record({ inputTokens: 1_000_000, outputTokens: 250_000 }); // $9
    expect(await cap.check()).toEqual({ exhausted: false });
    await cap.record({ inputTokens: 0, outputTokens: 50_000 }); // $1 → $10
    expect(await cap.check()).toEqual({
      exhausted: true,
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
  });

  it("starts over at the beginning of the next UTC month", async () => {
    const clock = fakeClock("2026-12-31T23:59:59Z");
    const cap = createMemorySpendCap({ budgetUsd: 1, pricing, now: clock.now });
    await cap.record({ inputTokens: 0, outputTokens: 100_000 }); // $2
    expect(await cap.check()).toMatchObject({
      exhausted: true,
      resetsAt: "2027-01-01T00:00:00.000Z",
    });

    clock.set("2027-01-01T00:00:00Z");
    expect(await cap.check()).toEqual({ exhausted: false });
  });

  it("a zero budget disables the chat", async () => {
    const cap = createMemorySpendCap({ budgetUsd: 0, pricing });
    expect((await cap.check()).exhausted).toBe(true);
  });
});
