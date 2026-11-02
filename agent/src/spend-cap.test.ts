import { describe, expect, it } from "vitest";
import { createMemorySpendCap, usageCostUsd, type SpendCap } from "./spend-cap";

const pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };
const none = { inputTokens: 0, outputTokens: 0 };

function fakeClock(iso: string) {
  let now = Date.parse(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = Date.parse(next);
    },
  };
}

/** Reserves, records `usage` and settles: one whole request. */
async function spend(cap: SpendCap, usage: { inputTokens: number; outputTokens: number }) {
  const status = await cap.reserve(none);
  if (status.exhausted) throw new Error("budget exhausted");
  await status.reservation.record(usage);
  await status.reservation.settle();
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

    await spend(cap, { inputTokens: 1_000_000, outputTokens: 250_000 }); // $9
    expect((await cap.reserve(none)).exhausted).toBe(false);
    await spend(cap, { inputTokens: 0, outputTokens: 50_000 }); // $1 → $10
    expect(await cap.reserve(none)).toEqual({
      exhausted: true,
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
  });

  it("holds each open request's worst case, so concurrent requests can't overshoot the budget", async () => {
    const cap = createMemorySpendCap({ budgetUsd: 10, pricing });
    const worstCase = { inputTokens: 0, outputTokens: 300_000 }; // $6

    const first = await cap.reserve(worstCase);
    if (first.exhausted) throw new Error("expected room");
    // $6 held: a second $6 worst case doesn't fit in the $4 left.
    expect((await cap.reserve(worstCase)).exhausted).toBe(true);

    // The first request actually spent $1: settling frees the rest.
    await first.reservation.record({ inputTokens: 0, outputTokens: 50_000 });
    await first.reservation.settle();
    expect((await cap.reserve(worstCase)).exhausted).toBe(false);
  });

  it("charges what a request actually spent, even beyond its reservation", async () => {
    const cap = createMemorySpendCap({ budgetUsd: 10, pricing });
    const status = await cap.reserve({ inputTokens: 0, outputTokens: 50_000 }); // $1
    if (status.exhausted) throw new Error("expected room");
    await status.reservation.record({ inputTokens: 0, outputTokens: 500_000 }); // $10
    await status.reservation.settle();
    expect((await cap.reserve(none)).exhausted).toBe(true);
  });

  it("starts over at the beginning of the next UTC month", async () => {
    const clock = fakeClock("2026-12-31T23:59:59Z");
    const cap = createMemorySpendCap({ budgetUsd: 1, pricing, now: clock.now });
    await spend(cap, { inputTokens: 0, outputTokens: 100_000 }); // $2
    expect(await cap.reserve(none)).toMatchObject({
      exhausted: true,
      resetsAt: "2027-01-01T00:00:00.000Z",
    });

    clock.set("2027-01-01T00:00:00Z");
    expect((await cap.reserve(none)).exhausted).toBe(false);
  });

  it("a zero budget disables the chat", async () => {
    const cap = createMemorySpendCap({ budgetUsd: 0, pricing });
    expect((await cap.reserve(none)).exhausted).toBe(true);
  });
});
