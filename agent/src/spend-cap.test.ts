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

/** Reserves and settles with `usage`: one whole request. */
async function spend(cap: SpendCap, usage: { inputTokens: number; outputTokens: number }) {
  const status = await cap.reserve(none);
  if (status.exhausted) throw new Error("spend cap reached");
  await status.reservation.settle(usage);
}

describe("createMemorySpendCap", () => {
  it("is open until the month's spend reaches the cap", async () => {
    const clock = fakeClock("2026-11-02T12:00:00Z");
    const cap = createMemorySpendCap({ capUsd: 10, pricing, now: clock.now });

    await spend(cap, { inputTokens: 1_000_000, outputTokens: 250_000 }); // $9
    expect((await cap.reserve(none)).exhausted).toBe(false);
    await spend(cap, { inputTokens: 0, outputTokens: 50_000 }); // $1 → $10
    expect(await cap.reserve(none)).toEqual({
      exhausted: true,
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
  });

  it("holds each open request's worst case, so concurrent requests can't overshoot the cap", async () => {
    const cap = createMemorySpendCap({ capUsd: 10, pricing });
    const worstCase = { inputTokens: 0, outputTokens: 300_000 }; // $6

    const first = await cap.reserve(worstCase);
    if (first.exhausted) throw new Error("expected room");
    // $6 held: a second $6 worst case doesn't fit in the $4 left.
    expect((await cap.reserve(worstCase)).exhausted).toBe(true);

    // The first request actually spent $1: settling frees the rest.
    await first.reservation.settle({ inputTokens: 0, outputTokens: 50_000 });
    expect((await cap.reserve(worstCase)).exhausted).toBe(false);
  });

  it("holds a worst case's input at the cache-write price, the most a settle can charge for it", async () => {
    const cap = createMemorySpendCap({ capUsd: 10, pricing });
    // 2M input tokens: $8 at the input price, $10 if all are written to the cache.
    const worstCase = { inputTokens: 2_000_000, outputTokens: 0 };

    const status = await cap.reserve(worstCase);
    if (status.exhausted) throw new Error("expected room");
    // The whole $10 is held: not even $0.50 more fits.
    expect((await cap.reserve({ inputTokens: 0, outputTokens: 25_000 })).exhausted).toBe(true);

    // Spending it as cache writes uses up exactly what was held.
    await status.reservation.settle({ ...worstCase, cacheWriteInputTokens: 2_000_000 });
    expect((await cap.reserve(none)).exhausted).toBe(true);
  });

  it("charges what a request actually spent, even beyond its reservation", async () => {
    const cap = createMemorySpendCap({ capUsd: 10, pricing });
    const status = await cap.reserve({ inputTokens: 0, outputTokens: 50_000 }); // $1
    if (status.exhausted) throw new Error("expected room");
    await status.reservation.settle({ inputTokens: 0, outputTokens: 500_000 }); // $10
    expect((await cap.reserve(none)).exhausted).toBe(true);
  });

  it("starts over at the beginning of the next UTC month", async () => {
    const clock = fakeClock("2026-12-31T23:59:59Z");
    const cap = createMemorySpendCap({ capUsd: 1, pricing, now: clock.now });
    await spend(cap, { inputTokens: 0, outputTokens: 100_000 }); // $2
    expect(await cap.reserve(none)).toMatchObject({
      exhausted: true,
      resetsAt: "2027-01-01T00:00:00.000Z",
    });

    clock.set("2027-01-01T00:00:00Z");
    expect((await cap.reserve(none)).exhausted).toBe(false);
  });

  it("a zero cap disables the chat", async () => {
    const cap = createMemorySpendCap({ capUsd: 0, pricing });
    expect((await cap.reserve(none)).exhausted).toBe(true);
  });
});

describe("createStoreSpendCap", () => {
  const sixDollars = { inputTokens: 0, outputTokens: 300_000 };

  it("keeps the month's spend across a restart and shares it between instances", async () => {
    const store = createMemoryDocumentStore();
    const first = createStoreSpendCap({ store, capUsd: 10, pricing });
    await spend(first, { inputTokens: 1_000_000, outputTokens: 250_000 }); // $9

    // A cold start, and a second instance: both see the $9.
    const restarted = createStoreSpendCap({ store, capUsd: 10, pricing });
    const other = createStoreSpendCap({ store, capUsd: 10, pricing });
    await spend(restarted, { inputTokens: 0, outputTokens: 50_000 }); // $1 → $10
    expect((await other.reserve(none)).exhausted).toBe(true);
  });

  it("lets concurrent requests on several instances hold no more than the cap", async () => {
    const store = createMemoryDocumentStore();
    const caps = Array.from({ length: 6 }, () =>
      createStoreSpendCap({ store, capUsd: 20, pricing }),
    );
    const statuses = await Promise.all(caps.map((cap) => cap.reserve(sixDollars)));
    // Three $6 worst cases fit in $20; the other three are refused.
    expect(statuses.filter((s) => !s.exhausted)).toHaveLength(3);
  });

  it("releases on settle what a request held and didn't spend, and charges overruns in full", async () => {
    const store = createMemoryDocumentStore();
    const cap = createStoreSpendCap({ store, capUsd: 10, pricing });

    const first = await cap.reserve(sixDollars);
    if (first.exhausted) throw new Error("expected room");
    expect((await cap.reserve(sixDollars)).exhausted).toBe(true);
    await first.reservation.settle({ inputTokens: 0, outputTokens: 50_000 }); // $1
    // Only the first settle counts.
    await first.reservation.settle({ inputTokens: 0, outputTokens: 450_000 });
    expect((await cap.reserve(sixDollars)).exhausted).toBe(false);

    const status = await cap.reserve(none);
    if (status.exhausted) throw new Error("expected room");
    await status.reservation.settle({ inputTokens: 0, outputTokens: 450_000 }); // $9
    // $1 + $9 spent, plus the $6 still held above.
    expect((await cap.reserve(none)).exhausted).toBe(true);
  });

  it("charges a hold its instance never settled at its worst case once it expires", async () => {
    const clock = fakeClock("2026-11-02T12:00:00Z");
    const store = createMemoryDocumentStore();
    const options = { store, capUsd: 10, pricing, reservationTtlMs: 600_000, now: clock.now };
    const crashed = createStoreSpendCap(options);
    const status = await crashed.reserve(sixDollars);
    if (status.exhausted) throw new Error("expected room");
    // The instance dies here: what it spent was only in its memory.

    const survivor = createStoreSpendCap(options);
    clock.set("2026-11-02T12:10:00Z");
    // The $6 hold is now $6 spent: $4.50 doesn't fit, $4 does.
    expect((await survivor.reserve({ inputTokens: 0, outputTokens: 225_000 })).exhausted).toBe(true);
    expect((await survivor.reserve({ inputTokens: 0, outputTokens: 200_000 })).exhausted).toBe(false);
  });

  it("charges only an overrun past the worst case when a request settles after its hold expired", async () => {
    const clock = fakeClock("2026-11-02T12:00:00Z");
    const store = createMemoryDocumentStore();
    const cap = createStoreSpendCap({ store, capUsd: 10, pricing, reservationTtlMs: 600_000, now: clock.now });
    const slow = await cap.reserve(sixDollars);
    const slower = await cap.reserve({ inputTokens: 0, outputTokens: 50_000 }); // $1
    if (slow.exhausted || slower.exhausted) throw new Error("expected room");
    clock.set("2026-11-02T12:10:00Z");
    // Charges both holds at their worst case: $7 spent, $4 doesn't fit.
    expect((await cap.reserve({ inputTokens: 0, outputTokens: 200_000 })).exhausted).toBe(true);

    await slow.reservation.settle({ inputTokens: 0, outputTokens: 50_000 }); // $1, under its $6
    await slower.reservation.settle({ inputTokens: 0, outputTokens: 100_000 }); // $2: $1 over its $1
    // $6 + $1 + the $1 over: $2 left.
    expect((await cap.reserve({ inputTokens: 0, outputTokens: 100_000 })).exhausted).toBe(false);
    expect((await cap.reserve({ inputTokens: 0, outputTokens: 5_000 })).exhausted).toBe(true);
  });

  it("logs a settle the store can't take instead of throwing, and charges its hold at its worst case once it expires", async () => {
    const clock = fakeClock("2026-11-04T10:00:00Z");
    const memory = createMemoryDocumentStore();
    let down = false;
    const store: DocumentStore = {
      update: (path, change) =>
        down ? Promise.reject(new Error("unreachable")) : memory.update(path, change),
    };
    const cap = createStoreSpendCap({
      store,
      capUsd: 10,
      pricing,
      now: clock.now,
      reservationTtlMs: 15 * 60_000,
    });
    const status = await cap.reserve(sixDollars);
    if (status.exhausted) throw new Error("expected room");

    down = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(status.reservation.settle({ inputTokens: 0, outputTokens: 50_000 })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    down = false;

    expect((await cap.reserve(sixDollars)).exhausted).toBe(true);
    clock.set("2026-11-04T10:16:00Z");
    // The $6 held is charged, not released: $4 is left, not $10.
    expect((await cap.reserve(sixDollars)).exhausted).toBe(true);
    expect((await cap.reserve({ inputTokens: 0, outputTokens: 200_000 })).exhausted).toBe(false);
  });

  it("caps each UTC month separately", async () => {
    const clock = fakeClock("2026-12-31T23:59:59Z");
    const store = createMemoryDocumentStore();
    const cap = createStoreSpendCap({ store, capUsd: 1, pricing, now: clock.now });
    await spend(cap, { inputTokens: 0, outputTokens: 100_000 }); // $2
    expect(await cap.reserve(none)).toEqual({
      exhausted: true,
      resetsAt: "2027-01-01T00:00:00.000Z",
    });
    clock.set("2027-01-01T00:00:00Z");
    expect((await cap.reserve(none)).exhausted).toBe(false);
  });
});
