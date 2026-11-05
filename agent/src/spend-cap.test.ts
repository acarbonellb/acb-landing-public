import { describe, expect, it, vi } from "vitest";
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { createMemorySpendCap, createStoreSpendCap, type SpendCap } from "./spend-cap";

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

describe("createStoreSpendCap", () => {
  const sixDollars = { inputTokens: 0, outputTokens: 300_000 };

  it("keeps the month's spend across a restart and shares it between instances", async () => {
    const store = createMemoryDocumentStore();
    const first = createStoreSpendCap({ store, budgetUsd: 10, pricing });
    await spend(first, { inputTokens: 1_000_000, outputTokens: 250_000 }); // $9

    // A cold start, and a second instance: both see the $9.
    const restarted = createStoreSpendCap({ store, budgetUsd: 10, pricing });
    const other = createStoreSpendCap({ store, budgetUsd: 10, pricing });
    await spend(restarted, { inputTokens: 0, outputTokens: 50_000 }); // $1 → $10
    expect((await other.reserve(none)).exhausted).toBe(true);
  });

  it("lets concurrent requests on several instances hold no more than the budget", async () => {
    const store = createMemoryDocumentStore();
    const caps = Array.from({ length: 6 }, () =>
      createStoreSpendCap({ store, budgetUsd: 20, pricing }),
    );
    const statuses = await Promise.all(caps.map((cap) => cap.reserve(sixDollars)));
    // Three $6 worst cases fit in $20; the other three are refused.
    expect(statuses.filter((s) => !s.exhausted)).toHaveLength(3);
  });

  it("releases on settle what a request held and didn't spend, and charges overruns in full", async () => {
    const store = createMemoryDocumentStore();
    const cap = createStoreSpendCap({ store, budgetUsd: 10, pricing });

    const first = await cap.reserve(sixDollars);
    if (first.exhausted) throw new Error("expected room");
    expect((await cap.reserve(sixDollars)).exhausted).toBe(true);
    await first.reservation.record({ inputTokens: 0, outputTokens: 50_000 }); // $1
    await first.reservation.settle();
    await first.reservation.settle();
    expect((await cap.reserve(sixDollars)).exhausted).toBe(false);

    const status = await cap.reserve(none);
    if (status.exhausted) throw new Error("expected room");
    await status.reservation.record({ inputTokens: 0, outputTokens: 450_000 }); // $9
    await status.reservation.settle();
    // $1 + $9 spent, plus the $6 still held above.
    expect((await cap.reserve(none)).exhausted).toBe(true);
  });

  it("drops a hold its instance never settled once it expires, but keeps what it spent", async () => {
    const clock = fakeClock("2026-11-02T12:00:00Z");
    const store = createMemoryDocumentStore();
    const options = { store, budgetUsd: 10, pricing, holdTtlMs: 600_000, now: clock.now };
    const crashed = createStoreSpendCap(options);
    const status = await crashed.reserve(sixDollars);
    if (status.exhausted) throw new Error("expected room");
    await status.reservation.record({ inputTokens: 0, outputTokens: 100_000 }); // $2
    // The instance dies here: no settle. $2 spent + $4 still held.

    const survivor = createStoreSpendCap(options);
    expect((await survivor.reserve(sixDollars)).exhausted).toBe(true);
    clock.set("2026-11-02T12:10:00Z");
    // The hold is gone; the $2 spent stays: $6 fits in the $8 left, $9 doesn't.
    expect((await survivor.reserve({ inputTokens: 0, outputTokens: 450_000 })).exhausted).toBe(true);
    expect((await survivor.reserve(sixDollars)).exhausted).toBe(false);
  });

  it("keeps the hold when a usage can't be recorded, so the call it was for still counts", async () => {
    const memory = createMemoryDocumentStore();
    let down = false;
    const store: DocumentStore = {
      update: (path, change) =>
        down ? Promise.reject(new Error("unreachable")) : memory.update(path, change),
    };
    const cap = createStoreSpendCap({ store, budgetUsd: 10, pricing });
    const status = await cap.reserve(sixDollars);
    if (status.exhausted) throw new Error("expected room");

    down = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // Doesn't throw: the answer the visitor is reading goes on.
    await status.reservation.record({ inputTokens: 0, outputTokens: 50_000 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    down = false;
    await status.reservation.settle();
    // The $6 stays held (until it expires) instead of the $1 going uncharged.
    expect((await cap.reserve(sixDollars)).exhausted).toBe(true);
  });

  it("budgets each UTC month separately", async () => {
    const clock = fakeClock("2026-12-31T23:59:59Z");
    const store = createMemoryDocumentStore();
    const cap = createStoreSpendCap({ store, budgetUsd: 1, pricing, now: clock.now });
    await spend(cap, { inputTokens: 0, outputTokens: 100_000 }); // $2
    expect(await cap.reserve(none)).toEqual({
      exhausted: true,
      resetsAt: "2027-01-01T00:00:00.000Z",
    });
    clock.set("2027-01-01T00:00:00Z");
    expect((await cap.reserve(none)).exhausted).toBe(false);
  });
});
