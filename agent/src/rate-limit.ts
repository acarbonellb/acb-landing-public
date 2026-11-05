// Rate limiting per rate-limit key (the client IP, or its /64 for IPv6) for the chat and MCP endpoints.
//
// Two implementations of `RateLimiter`: `createStoreRateLimiter` keeps the
// counts in a shared `DocumentStore` (Firestore in production), so they hold
// across Cloud Run instances and cold starts; `createMemoryRateLimiter` keeps
// them in this process, for local development and tests.
import type { DocumentStore } from "./document-store";

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

/** Collection of the store-backed windows, one document per limiter and key. */
export const rateLimitCollection = "rateLimits";

/**
 * Rate limiter over a shared store: each key's window is the document
 * `rateLimits/<name>:<key>`, updated atomically, so every instance counts
 * against the same limit. Each window carries `expireAt` (its end) for a
 * Firestore TTL policy to delete it.
 */
export function createStoreRateLimiter(
  options: RateLimitOptions & {
    store: DocumentStore;
    /** Tells limiters on the same store apart (e.g. "chat", "mcp"). */
    name: string;
  },
): RateLimiter {
  const { store, name, windowMs, now = Date.now } = options;
  return {
    hit(key) {
      const t = now();
      const path = `${rateLimitCollection}/${name}:${encodeURIComponent(key)}`;
      return store.update(path, (doc) => {
        const w = doc && { start: Number(doc.start), count: Number(doc.count) };
        const { decision, next } = hitWindow(w, t, options);
        return {
          result: decision,
          doc: next && { ...next, expireAt: new Date(next.start + windowMs) },
        };
      });
    },
  };
}
