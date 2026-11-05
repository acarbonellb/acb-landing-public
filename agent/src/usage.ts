// Usage monitoring: weekly aggregates of chat and MCP requests, served
// publicly by `GET /stats` (README, "Usage stats").
//
// One document per ISO week (`usage/<YYYY-Www>`) in the same `DocumentStore`
// as the guardrails (Firestore in production, memory locally). Each chat
// request is folded into it once, when it ends: its outcome, tokens, estimated
// cost (list prices, `pricing.ts`) and latency as fixed histogram buckets, so
// percentiles can be read back without keeping any sample. MCP requests are
// only counted. Nothing about the message content or the client is kept.
//
// Recording is best effort: a failure is logged and swallowed, so it never
// fails the request being recorded.
//
// The same document watches the chat's error rate for the `chat_error_rate`
// alert event (README, "Logs and alert events"): streamed requests and their
// errors are also counted in 10-minute buckets (`errorWindow`, pruned past
// the hour), and the event fires once when the last hour's rate passes the
// threshold (noted under `alerted`, in the same atomic update), then once
// more as `chat_error_rate_recovered` when it's back under. The window starts
// afresh with each week's document.
import type { TokenUsage } from "../../src/shared/chat-contract";
import type {
  ChatOutcome,
  LatencyPercentiles,
  StatsResponse,
  WeekStats,
} from "../../src/shared/stats-contract";
import type { DocumentStore, StoreDocument } from "./document-store";
import { describeError, logEvent } from "./log";
import { usageCostUsd, type Pricing } from "./pricing";

export type { ChatOutcome, StatsResponse, WeekStats };

/** One chat request, as it is recorded. */
export type ChatRecord = {
  outcome: ChatOutcome;
  /** Tokens of all its model calls (none for a refusal before streaming). */
  usage?: TokenUsage;
  /** From arrival to the end of the stream; only for streamed requests. */
  totalMs?: number;
  /** From arrival to the first text of the answer, if any came. */
  firstTextMs?: number;
  /** Model calls the request made (none for a refusal before streaming). */
  modelCalls?: number;
};

export interface UsageRecorder {
  /**
   * Logs one chat request (`chat_request`) and folds it into this week's
   * aggregates. Never throws.
   */
  recordChat(record: ChatRecord): Promise<void>;
  /** Counts one MCP request. Never throws. */
  recordMcp(): Promise<void>;
  /** This week's and the previous week's aggregates. */
  stats(): Promise<StatsResponse>;
}

/** When the chat's error rate over the last hour logs `chat_error_rate`. */
export type ErrorRateAlert = {
  /** Share of streamed requests that ended in an error, above which it fires (0 to 1). */
  threshold: number;
  /** Streamed requests the hour needs before its rate is judged either way. */
  minRequests: number;
};

/** The code default, overridden by configuration (`config.ts`). */
export const defaultErrorRateAlert: ErrorRateAlert = { threshold: 0.2, minRequests: 5 };

export type UsageOptions = {
  store: DocumentStore;
  pricing: Pricing;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  errorRateAlert?: ErrorRateAlert;
};

/** Size of the error-rate window's buckets, and the window (the current bucket and the 5 before). */
const errorBucketMs = 10 * 60_000;
const errorWindowMinutes = 60;

/** Collection of the weekly usage documents. */
export const usageCollection = "usage";

/**
 * Upper bounds (ms) of the latency buckets; a last, unbounded bucket (`inf`)
 * takes the rest. Fine where chat answers usually land (1–10 s), coarse up to
 * Cloud Run's 5-minute request timeout.
 */
export const latencyBucketsMs = [
  250, 500, 1000, 2000, 3000, 5000, 7500, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000, 300_000,
] as const;

type Histogram = Record<string, number>;

const bucketOf = (ms: number) => String(latencyBucketsMs.find((bound) => ms <= bound) ?? "inf");

const day = 24 * 60 * 60_000;

/** The ISO week (Monday to Sunday, UTC) containing `t`. */
export function isoWeek(t: number): { week: string; startsAt: string } {
  const date = new Date(t);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  const monday = midnight - weekday * day;
  // The week belongs to the year its Thursday is in.
  const thursday = new Date(monday + 3 * day);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * day)) + 1;
  return {
    week: `${year}-W${String(number).padStart(2, "0")}`,
    startsAt: new Date(monday).toISOString(),
  };
}

/** A week's document as stored. */
type WeekDoc = {
  week: string;
  chat: {
    requests: number;
    outcomes: Partial<Record<ChatOutcome, number>>;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    totalMs: Histogram;
    firstTextMs: Histogram;
  };
  mcp: { requests: number };
  /** Streamed chat requests and their errors per 10-minute bucket, keyed by its start (ms). */
  errorWindow: Record<string, { streamed: number; errors: number }>;
  /** Alert events in effect: `chat_error_rate` while the rate is above its threshold. */
  alerted: Record<string, boolean>;
};

function readWeek(week: string, doc: StoreDocument | undefined): WeekDoc {
  const chat = (doc?.chat ?? {}) as Partial<WeekDoc["chat"]>;
  const mcp = (doc?.mcp ?? {}) as Partial<WeekDoc["mcp"]>;
  return {
    errorWindow: { ...(doc?.errorWindow as WeekDoc["errorWindow"] | undefined) },
    alerted: { ...(doc?.alerted as WeekDoc["alerted"] | undefined) },
    week,
    chat: {
      requests: Number(chat.requests ?? 0),
      outcomes: { ...chat.outcomes },
      inputTokens: Number(chat.inputTokens ?? 0),
      outputTokens: Number(chat.outputTokens ?? 0),
      costUsd: Number(chat.costUsd ?? 0),
      totalMs: { ...chat.totalMs },
      firstTextMs: { ...chat.firstTextMs },
    },
    mcp: { requests: Number(mcp.requests ?? 0) },
  };
}

const add = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Upper bound of the bucket holding quantile `q`, or `null` (none, or unbounded). */
function percentile(histogram: Histogram, q: number): number | null {
  const total = Object.values(histogram).reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const rank = Math.ceil(q * total);
  let seen = 0;
  for (const bound of latencyBucketsMs) {
    seen += histogram[String(bound)] ?? 0;
    if (seen >= rank) return bound;
  }
  return null;
}

const percentiles = (histogram: Histogram): LatencyPercentiles => ({
  p50Ms: percentile(histogram, 0.5),
  p95Ms: percentile(histogram, 0.95),
});

const answeredOutcomes: ChatOutcome[] = ["end_turn", "max_tokens", "max_iterations", "refusal"];
const refusedOutcomes: ChatOutcome[] = ["http_429", "http_503"];

function summarize(doc: WeekDoc, startsAt: string): WeekStats {
  const { chat } = doc;
  const count = (outcomes: ChatOutcome[]) =>
    outcomes.reduce((sum, outcome) => sum + (chat.outcomes[outcome] ?? 0), 0);
  const errors = Object.entries(chat.outcomes)
    .filter(([outcome]) => outcome.startsWith("error:"))
    .reduce((sum, [, n]) => sum + (n ?? 0), 0);
  const streamed = chat.requests - count(refusedOutcomes);
  return {
    week: doc.week,
    startsAt,
    chat: {
      requests: chat.requests,
      answered: count(answeredOutcomes),
      outcomes: chat.outcomes,
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      // Sums of small floats: drop the binary noise.
      costUsd: Math.round(chat.costUsd * 1e6) / 1e6,
      errorRate: streamed > 0 ? errors / streamed : null,
      latency: percentiles(chat.totalMs),
      firstText: percentiles(chat.firstTextMs),
    },
    mcp: doc.mcp,
  };
}

/** What the error-rate watch saw when a streamed request was folded in. */
type ErrorRateChange = {
  crossed?: "above" | "below";
  streamed: number;
  errors: number;
};

/**
 * Counts one streamed request in the week's error window, prunes buckets past
 * the hour, and flips `alerted.chat_error_rate` if the hour's rate crossed
 * the threshold either way.
 */
function countStreamed(week: WeekDoc, t: number, failed: boolean, alert: ErrorRateAlert): ErrorRateChange {
  const bucket = Math.floor(t / errorBucketMs) * errorBucketMs;
  const oldest = bucket - (errorWindowMinutes * 60_000 - errorBucketMs);
  const window = Object.fromEntries(
    Object.entries(week.errorWindow).filter(([start]) => Number(start) >= oldest),
  );
  const current = (window[String(bucket)] ??= { streamed: 0, errors: 0 });
  current.streamed++;
  if (failed) current.errors++;
  week.errorWindow = window;

  const counts = Object.values(window);
  const streamed = counts.reduce((sum, b) => sum + b.streamed, 0);
  const errors = counts.reduce((sum, b) => sum + b.errors, 0);
  if (streamed < alert.minRequests) return { streamed, errors };
  const above = errors / streamed > alert.threshold;
  if (above === Boolean(week.alerted.chat_error_rate)) return { streamed, errors };
  week.alerted = { ...week.alerted, chat_error_rate: above };
  return { crossed: above ? "above" : "below", streamed, errors };
}

export function createUsageRecorder(options: UsageOptions): UsageRecorder {
  const { store, pricing, now = Date.now, errorRateAlert = defaultErrorRateAlert } = options;

  /**
   * Applies `change` to the current week's document and returns what it
   * returned; logs and swallows failures (`undefined`).
   */
  async function fold<R>(what: string, change: (week: WeekDoc, t: number) => R): Promise<R | undefined> {
    const t = now();
    const { week } = isoWeek(t);
    try {
      return await store.update(`${usageCollection}/${week}`, (doc) => {
        const next = readWeek(week, doc);
        const result = change(next, t);
        return { doc: next as unknown as StoreDocument, result };
      });
    } catch (error) {
      // Not rethrown: monitoring must never fail the request it watches.
      logEvent("ERROR", "store_error", `Usage: could not record ${what}`, {
        operation: "usage_record",
        error: describeError(error),
      });
      return undefined;
    }
  }

  function logErrorRate(week: string, { crossed, streamed, errors }: ErrorRateChange) {
    if (!crossed) return;
    const fields = {
      week,
      windowMinutes: errorWindowMinutes,
      streamed,
      errors,
      errorRate: errors / streamed,
      threshold: errorRateAlert.threshold,
    };
    if (crossed === "above") {
      logEvent("ERROR", "chat_error_rate", "Chat error rate over the last hour is above its threshold", fields);
    } else {
      logEvent("INFO", "chat_error_rate_recovered", "Chat error rate over the last hour is back under its threshold", fields);
    }
  }

  async function readStats(t: number): Promise<WeekStats> {
    const { week, startsAt } = isoWeek(t);
    const doc = await store.update(`${usageCollection}/${week}`, (d) => ({ result: d }));
    return summarize(readWeek(week, doc), startsAt);
  }

  return {
    async recordChat({ outcome, usage, totalMs, firstTextMs, modelCalls = 0 }) {
      const { week } = isoWeek(now());
      logEvent("INFO", "chat_request", `Chat request: ${outcome}`, {
        outcome,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: usage ? usageCostUsd(usage, pricing) : 0,
        totalMs: totalMs ?? null,
        firstTextMs: firstTextMs ?? null,
        modelCalls,
      });
      const streamed = !refusedOutcomes.includes(outcome);
      const change = await fold(`a chat request (${outcome})`, (week, t) => {
        const { chat } = week;
        chat.requests++;
        add(chat.outcomes, outcome);
        if (usage) {
          chat.inputTokens += usage.inputTokens;
          chat.outputTokens += usage.outputTokens;
          chat.costUsd += usageCostUsd(usage, pricing);
        }
        if (totalMs !== undefined) add(chat.totalMs, bucketOf(totalMs));
        if (firstTextMs !== undefined) add(chat.firstTextMs, bucketOf(firstTextMs));
        return streamed ? countStreamed(week, t, outcome.startsWith("error:"), errorRateAlert) : undefined;
      });
      if (change) logErrorRate(week, change);
    },
    async recordMcp() {
      await fold("an MCP request", ({ mcp }) => {
        mcp.requests++;
      });
    },
    async stats() {
      const t = now();
      const [current, previous] = await Promise.all([readStats(t), readStats(t - 7 * day)]);
      return { current, previous };
    },
  };
}
