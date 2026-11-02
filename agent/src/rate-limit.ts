// Per-key (per-IP) rate limiting for the chat and MCP endpoints.
//
// The default store is in memory, so its counts are PER INSTANCE: Cloud Run
// may run several instances (each with its own counts, so the effective limit
// is `limit × instances`) and scales to zero (a cold start forgets every
// count). That is fine as an abuse brake for a portfolio; the monthly spend
// cap is the hard cost guard. For a strict global limit, implement
// `RateLimiter` over a shared store (e.g. Redis/Memorystore `INCR` + `PEXPIRE`
// on `ratelimit:<key>:<window>`, or a Firestore counter in a transaction) and
// inject it through `AppDeps`. The interface is async for that reason.

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; /** Whole seconds until a request will be allowed. */ retryAfterSeconds: number };

export interface RateLimiter {
  /** Counts one request for `key` and says whether it may proceed. */
  hit(key: string): Promise<RateLimitDecision>;
}

export type RateLimitOptions = {
  /** Requests allowed per key in one window. */
  limit: number;
  windowMs: number;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Fixed-window counter per key: the first request opens a window of
 * `windowMs`; up to `limit` requests pass in it. Refused requests don't count.
 */
export function createMemoryRateLimiter(
  options: RateLimitOptions,
): RateLimiter & { /** Keys currently tracked (for tests). */ size(): number } {
  const { limit, windowMs, now = Date.now } = options;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();

  // Drop expired windows at most once per window length, so memory is
  // bounded by the keys seen in the last two windows.
  function sweep(t: number) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [key, w] of windows) {
      if (t - w.start >= windowMs) windows.delete(key);
    }
  }

  return {
    async hit(key) {
      const t = now();
      sweep(t);
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        windows.set(key, { start: t, count: 1 });
        return { allowed: true };
      }
      if (w.count < limit) {
        w.count++;
        return { allowed: true };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)),
      };
    },
    size: () => windows.size,
  };
}
