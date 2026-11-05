import { describe, expect, it, vi } from "vitest";
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { createFirestoreDocumentStore } from "./firestore";
import { fakeFirestore, root } from "./firestore-fake";
import { createUsageRecorder, isoWeek } from "./usage";

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

const answered = (totalMs: number, firstTextMs?: number) => ({
  outcome: "end_turn" as const,
  usage: { inputTokens: 1000, outputTokens: 100 },
  totalMs,
  firstTextMs,
});

describe("isoWeek", () => {
  it("names the ISO week of a UTC time, Monday to Sunday", () => {
    expect(isoWeek(Date.parse("2026-11-02T00:00:00Z"))).toEqual({
      week: "2026-W45",
      startsAt: "2026-11-02T00:00:00.000Z",
    });
    expect(isoWeek(Date.parse("2026-11-08T23:59:59Z")).week).toBe("2026-W45");
    expect(isoWeek(Date.parse("2026-11-09T00:00:00Z")).week).toBe("2026-W46");
  });

  it("counts the days around New Year in the week's ISO year", () => {
    // 2026 starts on a Thursday, so it has 53 weeks; 2027 starts on a Friday.
    expect(isoWeek(Date.parse("2026-01-01T12:00:00Z")).week).toBe("2026-W01");
    expect(isoWeek(Date.parse("2027-01-03T12:00:00Z")).week).toBe("2026-W53");
    expect(isoWeek(Date.parse("2027-01-04T12:00:00Z")).week).toBe("2027-W01");
    expect(isoWeek(Date.parse("2025-12-29T12:00:00Z")).week).toBe("2026-W01");
  });
});

describe("createUsageRecorder", () => {
  it("reports this week's chat requests, outcomes, tokens, cost and latency", async () => {
    const clock = fakeClock("2026-11-04T10:00:00Z");
    const usage = createUsageRecorder({ store: createMemoryDocumentStore(), pricing, now: clock.now });

    await usage.recordChat(answered(1800, 400));
    await usage.recordChat({
      outcome: "error:unavailable",
      usage: { inputTokens: 500, outputTokens: 0 },
      totalMs: 900,
    });
    await usage.recordChat({ outcome: "http_429" });
    await usage.recordMcp();
    await usage.recordMcp();

    const { current, previous } = await usage.stats();
    expect(current).toEqual({
      week: "2026-W45",
      startsAt: "2026-11-02T00:00:00.000Z",
      chat: {
        requests: 3,
        answered: 1,
        outcomes: { end_turn: 1, "error:unavailable": 1, http_429: 1 },
        inputTokens: 1500,
        outputTokens: 100,
        costUsd: 0.008, // 1500 × $4/M + 100 × $20/M
        errorRate: 0.5, // 1 of the 2 that streamed; the 429 never did
        latency: { p50Ms: 1000, p95Ms: 2000 },
        firstText: { p50Ms: 500, p95Ms: 500 },
      },
      mcp: { requests: 2 },
    });
    expect(previous).toEqual({
      week: "2026-W44",
      startsAt: "2026-10-26T00:00:00.000Z",
      chat: {
        requests: 0,
        answered: 0,
        outcomes: {},
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        errorRate: null,
        latency: { p50Ms: null, p95Ms: null },
        firstText: { p50Ms: null, p95Ms: null },
      },
      mcp: { requests: 0 },
    });
  });

  it("reads p50 and p95 from the latency buckets", async () => {
    const usage = createUsageRecorder({ store: createMemoryDocumentStore(), pricing });
    // 18 fast answers (≤ 2 s), one slow (≤ 10 s), one past the last bucket.
    for (let i = 0; i < 18; i++) await usage.recordChat(answered(1500 + i * 10));
    await usage.recordChat(answered(9000));
    await usage.recordChat(answered(400_000));

    const { latency } = (await usage.stats()).current.chat;
    expect(latency).toEqual({ p50Ms: 2000, p95Ms: 10_000 });

    await usage.recordChat(answered(400_000));
    // Now 2 of 21 are past the last bucket: p95 has no upper bound.
    expect((await usage.stats()).current.chat.latency).toEqual({ p50Ms: 2000, p95Ms: null });
  });

  it("starts a new document each ISO week and reports the previous one next to it", async () => {
    const clock = fakeClock("2026-11-08T23:59:00Z");
    const usage = createUsageRecorder({ store: createMemoryDocumentStore(), pricing, now: clock.now });
    await usage.recordChat(answered(1000));
    await usage.recordChat(answered(1000));

    clock.set("2026-11-09T00:01:00Z");
    await usage.recordChat({ outcome: "aborted", usage: { inputTokens: 10, outputTokens: 5 }, totalMs: 300 });

    const { current, previous } = await usage.stats();
    expect([current.week, current.chat.requests, current.chat.answered]).toEqual(["2026-W46", 1, 0]);
    expect([previous.week, previous.chat.requests, previous.chat.answered]).toEqual(["2026-W45", 2, 2]);
    // Visitors who left aren't errors.
    expect(current.chat.errorRate).toBe(0);
  });

  it("keeps only counts, tokens, cost and latency buckets: no content, no IPs", async () => {
    const store = createMemoryDocumentStore();
    const clock = fakeClock("2026-11-04T10:00:00Z");
    const usage = createUsageRecorder({ store, pricing, now: clock.now });
    await usage.recordChat(answered(1800, 400));
    await usage.recordMcp();

    const doc = await store.update("usage/2026-W45", (d) => ({ result: d }));
    expect(doc).toEqual({
      week: "2026-W45",
      chat: {
        requests: 1,
        outcomes: { end_turn: 1 },
        inputTokens: 1000,
        outputTokens: 100,
        costUsd: 0.006,
        totalMs: { "2000": 1 },
        firstTextMs: { "500": 1 },
      },
      mcp: { requests: 1 },
      // The error-rate alert's window: this 10-minute bucket, keyed by its start.
      errorWindow: { [String(Date.parse("2026-11-04T10:00:00Z"))]: { streamed: 1, errors: 0 } },
      alerted: {},
    });
  });

  it("logs a failure to record and never throws it", async () => {
    const broken: DocumentStore = {
      update: async () => {
        throw new Error("Firestore down");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const usage = createUsageRecorder({ store: broken, pricing });

    await expect(usage.recordChat(answered(1000))).resolves.toBeUndefined();
    await expect(usage.recordMcp()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toMatch(/usage/i);
    // Reading the stats does fail: `/stats` answers it.
    await expect(usage.stats()).rejects.toThrow(/Firestore down/);
    error.mockRestore();
  });

  it("counts concurrent requests without losing any", async () => {
    const usage = createUsageRecorder({ store: createMemoryDocumentStore(), pricing });
    await Promise.all([
      ...Array.from({ length: 10 }, () => usage.recordChat(answered(1000))),
      ...Array.from({ length: 5 }, () => usage.recordMcp()),
    ]);
    const { current } = await usage.stats();
    expect([current.chat.requests, current.mcp.requests]).toEqual([10, 5]);
  });

  it("round-trips the week's document through Firestore, and reading it writes nothing", async () => {
    const fake = fakeFirestore();
    const store = createFirestoreDocumentStore({
      projectId: "acb-landing",
      emulatorHost: "localhost:8081",
      fetch: fake.fetch,
    });
    const clock = fakeClock("2026-11-04T10:00:00Z");
    const usage = createUsageRecorder({ store, pricing, now: clock.now });

    await usage.recordChat(answered(1800, 400));
    await usage.recordChat({ outcome: "error:internal", usage: { inputTokens: 0, outputTokens: 0 }, totalMs: 100 });
    await usage.recordMcp();
    expect([...fake.docs.keys()]).toEqual([`${root}/usage/2026-W45`]);

    const writes = fake.requests.filter((r) => r.method === "POST").length;
    const { current } = await usage.stats();
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(writes);
    expect(current.chat).toMatchObject({
      requests: 2,
      outcomes: { end_turn: 1, "error:internal": 1 },
      costUsd: 0.006,
      errorRate: 0.5,
      latency: { p50Ms: 250, p95Ms: 2000 },
    });
    expect(current.mcp.requests).toBe(1);
  });
});
