import { describe, expect, it } from "vitest";
import { createMemoryDocumentStore } from "./document-store";
import { createMemoryRateLimiter, createStoreRateLimiter, withRefusalCache } from "./rate-limit";

function fakeClock(start = Date.UTC(2026, 10, 2, 12, 0, 0)) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createMemoryRateLimiter", () => {
  it("allows up to `limit` hits per key in a window, then refuses with the wait", async () => {
    const clock = fakeClock();
    const limiter = createMemoryRateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });

    for (let i = 0; i < 3; i++) {
      expect(await limiter.hit("1.2.3.4")).toEqual({ allowed: true });
    }
    clock.advance(15_000);
    expect(await limiter.hit("1.2.3.4")).toEqual({
      allowed: false,
      retryAfterSeconds: 45,
    });
  });

  it("counts each key separately", async () => {
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000, now: fakeClock().now });
    expect(await limiter.hit("a")).toEqual({ allowed: true });
    expect(await limiter.hit("b")).toEqual({ allowed: true });
    expect((await limiter.hit("a")).allowed).toBe(false);
  });

  it("allows the key again once its window has passed", async () => {
    const clock = fakeClock();
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    await limiter.hit("a");
    clock.advance(59_999);
    expect(await limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    clock.advance(1);
    expect(await limiter.hit("a")).toEqual({ allowed: true });
  });

  it("does not extend the window with refused hits", async () => {
    const clock = fakeClock();
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 10_000, now: clock.now });
    await limiter.hit("a");
    for (let i = 0; i < 5; i++) {
      clock.advance(1_000);
      await limiter.hit("a");
    }
    clock.advance(5_000);
    expect(await limiter.hit("a")).toEqual({ allowed: true });
  });

  it("forgets expired keys so memory stays bounded", async () => {
    const clock = fakeClock();
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 1_000, now: clock.now });
    for (let i = 0; i < 100; i++) await limiter.hit(`ip-${i}`);
    expect(limiter.size()).toBe(100);
    clock.advance(1_000);
    await limiter.hit("late");
    expect(limiter.size()).toBe(1);
  });
});

describe("createStoreRateLimiter", () => {
  const options = { limit: 2, windowMs: 60_000 };

  it("shares each key's count between instances on the same store, and keeps it across a restart", async () => {
    const clock = fakeClock();
    const store = createMemoryDocumentStore();
    const a = createStoreRateLimiter({ store, name: "chat", ...options, now: clock.now });
    const b = createStoreRateLimiter({ store, name: "chat", ...options, now: clock.now });

    expect(await a.hit("2001:db8:0:1::/64")).toEqual({ allowed: true });
    expect(await b.hit("2001:db8:0:1::/64")).toEqual({ allowed: true });
    clock.advance(20_000);
    // A new instance (a cold start) sees the same window.
    const restarted = createStoreRateLimiter({ store, name: "chat", ...options, now: clock.now });
    expect(await restarted.hit("2001:db8:0:1::/64")).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
    });
    expect(await a.hit("2001:db8:0:2::/64")).toEqual({ allowed: true });
  });

  it("counts concurrent hits exactly", async () => {
    const store = createMemoryDocumentStore();
    const limiters = Array.from({ length: 5 }, () =>
      createStoreRateLimiter({ store, name: "chat", ...options, now: fakeClock().now }),
    );
    const decisions = await Promise.all(limiters.map((limiter) => limiter.hit("a")));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(2);
  });

  it("keeps separate counts per limiter name, and allows the key again after its window", async () => {
    const clock = fakeClock();
    const store = createMemoryDocumentStore();
    const chat = createStoreRateLimiter({ store, name: "chat", limit: 1, windowMs: 60_000, now: clock.now });
    const mcp = createStoreRateLimiter({ store, name: "mcp", limit: 1, windowMs: 60_000, now: clock.now });

    expect(await chat.hit("a")).toEqual({ allowed: true });
    expect(await mcp.hit("a")).toEqual({ allowed: true });
    expect((await chat.hit("a")).allowed).toBe(false);
    clock.advance(60_000);
    expect(await chat.hit("a")).toEqual({ allowed: true });
  });
});

describe("withRefusalCache", () => {
  it("never allows what the store would refuse, and asks the store again once the wait ends", async () => {
    const clock = fakeClock();
    const options = { name: "chat", limit: 2, windowMs: 60_000, now: clock.now };
    // The same hits, at the same times, through the cache and straight to a store.
    const cached = withRefusalCache(
      createStoreRateLimiter({ store: createMemoryDocumentStore(), ...options }),
      { now: clock.now },
    );
    const bare = createStoreRateLimiter({ store: createMemoryDocumentStore(), ...options });

    const steps = [0, 100, 900, 15_000, 20_500, 23_999, 1, 7_000, 500, 30_000, 12_345, 60_000];
    const allowed: boolean[] = [];
    for (const step of steps) {
      clock.advance(step);
      const fromStore = await bare.hit("a");
      const decision = await cached.hit("a");
      if (!fromStore.allowed) expect(decision).toEqual(fromStore);
      allowed.push(decision.allowed);
    }
    // Windows open at 0 s, 60.499 s and 170.345 s: two hits pass in each.
    expect(allowed).toEqual([
      true, true, false, false, false, true, true, false, false, false, false, true,
    ]);
  });

  it("keeps at most `maxKeys` refusals, forgetting the oldest, which the store is then asked about", async () => {
    const clock = fakeClock();
    const store = createStoreRateLimiter({
      store: createMemoryDocumentStore(),
      name: "chat",
      limit: 1,
      windowMs: 60_000,
      now: clock.now,
    });
    let asked = 0;
    const limiter = withRefusalCache(
      { hit: (key) => (asked++, store.hit(key)) },
      { maxKeys: 2, now: clock.now },
    );
    for (const key of ["a", "b", "c"]) await limiter.hit(key);
    for (const key of ["a", "b", "c"]) expect((await limiter.hit(key)).allowed).toBe(false);

    asked = 0;
    expect((await limiter.hit("b")).allowed).toBe(false);
    expect((await limiter.hit("c")).allowed).toBe(false);
    expect(asked).toBe(0);
    expect((await limiter.hit("a")).allowed).toBe(false);
    expect(asked).toBe(1);
  });
});
