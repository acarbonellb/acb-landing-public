// Rate limiting per rate-limit key (the client IP, or its /64 for IPv6) for the chat and MCP endpoints.
//
// The counts are kept in this process (`createMemoryRateLimiter`), in
// production too: the deploy runs one instance, so they are exact there, cost
// no store writes and can't fail (ADR 0003, amendment).

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

type Window = { start: number; count: number };

/**
 * Fixed-window counter: the first request opens a window of `windowMs`; up to
 * `limit` requests pass in it. Refused requests don't count, so they leave
 * the window as it was (`next` is undefined).
 */
function hitWindow(
  w: Window | undefined,
  t: number,
  { limit, windowMs }: RateLimitOptions,
): { decision: RateLimitDecision; next?: Window } {
  if (!w || t - w.start >= windowMs) {
    return { decision: { allowed: true }, next: { start: t, count: 1 } };
  }
  if (w.count < limit) {
    return { decision: { allowed: true }, next: { start: w.start, count: w.count + 1 } };
  }
  return {
    decision: {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)),
    },
  };
}

export function createMemoryRateLimiter(
  options: RateLimitOptions,
): RateLimiter & { /** Keys currently tracked (for tests). */ size(): number } {
  const { windowMs, now = Date.now } = options;
  const windows = new Map<string, Window>();
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
      const { decision, next } = hitWindow(windows.get(key), t, options);
      if (next) windows.set(key, next);
      return decision;
    },
    size: () => windows.size,
  };
}

/** The one key a global ceiling counts every request under. */
export const globalKey = "*";

/**
 * A per-key limiter under a global ceiling: a request the per-key limiter
 * allows is then counted against `ceiling` under one fixed key, so rotating
 * keys can't multiply what one source gets. Requests refused per key don't
 * count toward the ceiling. Either refusal reads the same to the caller.
 */
export function withGlobalCeiling(perKey: RateLimiter, ceiling: RateLimiter): RateLimiter {
  return {
    async hit(key) {
      const decision = await perKey.hit(key);
      return decision.allowed ? ceiling.hit(globalKey) : decision;
    },
  };
}
