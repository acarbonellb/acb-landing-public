// The wire contract of the agent's `GET /stats` endpoint (docs/usage-stats.md):
// weekly usage aggregates, with no message content and no IPs.
// Shared by the agent (which serves it) and the site (which shows a line
// from it). Types and plain constants only, so it is safe in either runtime.
import type { ChatErrorCode, ChatStopReason } from "./chat-contract";

/**
 * How a chat request ended: a stream that finished (`ChatStopReason`), ended
 * with an `error` event (`error:<code>`), or was cut off because the visitor
 * left (`aborted`); or a refusal before streaming, `http_429` (rate limited)
 * or `http_503` (no model, or the monthly spend cap reached).
 */
export type ChatOutcome =
  | ChatStopReason
  | `error:${ChatErrorCode}`
  | "aborted"
  | "http_429"
  | "http_503";

/**
 * Latency percentiles in ms, read from fixed histogram buckets: each is the
 * upper bound of the bucket the percentile falls in, so an upper estimate.
 * `null` with no samples, or when it falls past the last bucket.
 */
export type LatencyPercentiles = { p50Ms: number | null; p95Ms: number | null };

/** Usage of one ISO week (Monday 00:00 UTC to the next Monday). */
export type WeekStats = {
  /** ISO week, e.g. `2026-W45`. */
  week: string;
  /** ISO time the week starts. */
  startsAt: string;
  chat: {
    /** Every chat request counted, refusals before streaming included. */
    requests: number;
    /** Requests that got a whole answer: outcome `end_turn`, `max_tokens`, `max_iterations` or `refusal`. */
    answered: number;
    outcomes: Partial<Record<ChatOutcome, number>>;
    inputTokens: number;
    outputTokens: number;
    /** Estimated model spend, at the model's list prices (`agent/src/pricing.ts`). */
    costUsd: number;
    /** `error:*` outcomes over the requests that streamed; `null` if none did. */
    errorRate: number | null;
    /** From the request's arrival to the end of its stream. */
    latency: LatencyPercentiles;
    /** From the request's arrival to the answer's first text. */
    firstText: LatencyPercentiles;
  };
  mcp: {
    /** MCP HTTP requests served (a client's session is several). */
    requests: number;
    /**
     * `/mcp` requests, refused ones included, whose right-most hop was a
     * Google address outside the user-triggered fetchers ranges: the sign
     * the agent's ranges snapshot is stale.
     */
    unknownGoogleHops: number;
  };
};

/** Body of `GET /stats`. */
export type StatsResponse = { current: WeekStats; previous: WeekStats };
