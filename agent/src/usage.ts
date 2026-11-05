// Usage monitoring: weekly aggregates of chat and MCP requests, served
// publicly by `GET /stats` (README, "Usage stats").
//
// One document per ISO week (`usage/<YYYY-Www>`) in the same `DocumentStore`
// as the guardrails (Firestore in production, memory locally). Each chat
// request is folded into it once, when it ends: its outcome, tokens, estimated
// cost (list prices, `pricing.ts`) and latency as fixed histogram buckets, so
// percentiles can be read back without keeping any sample. MCP requests are
// only counted, and the request doesn't wait for that write. Nothing about
// the message content or the client is kept.
//
// Refusals (a chat request's `http_429` or `http_503`, what a flood is made
// of) and the hop-drift count are kept in memory and folded into the
// document in batches: on a timer, before `/stats` reads it, and on shutdown
// (`close`). So a flood that is already refused costs one write per batch,
// not one per request.
//
// Recording is best effort: a failure is logged and swallowed, so it never
// fails the request being recorded; a batch that fails to write is kept for
// the next one.
//
// The same document watches the chat's error rate for the `chat_error_rate`
// alert event (README, "Logs and alert events"): streamed requests and their
// errors are also counted in 10-minute buckets (`errorWindow`, pruned past
// the hour), and the event fires once when the last hour's rate passes the
// threshold (noted under `alerted`, in the same atomic update), then once
// more as `chat_error_rate_recovered` when it's back under. The window starts
// afresh with each week's document.
//
// Every chat request recorded is also logged, as one `chat_request` line.
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
   * aggregates; a refusal before streaming only joins the next batch. Never
   * throws.
   */
  recordChat(record: ChatRecord): Promise<void>;
  /** Counts one MCP request. Never throws; nobody needs to wait for it. */
  recordMcp(): Promise<void>;
  /**
   * Counts one `/mcp` request whose right-most hop is a Google address
   * outside the user-triggered fetchers ranges, in the next batch.
   */
  countUnknownGoogleHop(): void;
  /** Writes the batched counts. Never throws: a batch that fails is kept. */
  flush(): Promise<void>;
  /** Stops the batch timer and writes what is left, for shutdown. */
  close(): Promise<void>;
  /** This week's and the previous week's aggregates, batched counts written first. */
  stats(): Promise<StatsResponse>;
}

export type UsageOptions = {
  store: DocumentStore;
  pricing: Pricing;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /** How often the batched counts are written, in ms. */
  flushEveryMs?: number;
  errorRateAlert?: ErrorRateAlert;
};

/** When the chat's error rate over the last hour logs `chat_error_rate`. */
export type ErrorRateAlert = {
  /** Share of streamed requests that ended in an error, above which it fires (0 to 1). */
  threshold: number;
  /** Streamed requests the hour needs before its rate is judged either way. */
  minRequests: number;
};

/** The code default, overridden by configuration (`config.ts`). */
export const defaultErrorRateAlert: ErrorRateAlert = { threshold: 0.2, minRequests: 5 };

/** Size of the error-rate window's buckets, and the window (the current bucket and the 5 before). */
const errorBucketMs = 10 * 60_000;
const errorWindowMinutes = 60;

/** Default batch interval: well inside Cloud Run's shutdown grace and `/stats`' cache. */
export const defaultFlushEveryMs = 10_000;

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
  mcp: { requests: number; unknownGoogleHops: number };
  /** Streamed chat requests and their errors per 10-minute bucket, keyed by its start (ms). */
  errorWindow: Record<string, { streamed: number; errors: number }>;
  /** Alert events in effect: `chat_error_rate` while the rate is above its threshold. */
  alerted: Record<string, boolean>;
};

/** Counts waiting for the next batch, of one week. */
type Batch = { refusals: Record<string, number>; unknownGoogleHops: number };

const refusedOutcomes: ChatOutcome[] = ["http_429", "http_503"];

function readWeek(week: string, doc: StoreDocument | undefined): WeekDoc {
  const chat = (doc?.chat ?? {}) as Partial<WeekDoc["chat"]>;
  const mcp = (doc?.mcp ?? {}) as Partial<WeekDoc["mcp"]>;
  return {
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
    mcp: {
      requests: Number(mcp.requests ?? 0),
      unknownGoogleHops: Number(mcp.unknownGoogleHops ?? 0),
    },
    errorWindow: { ...(doc?.errorWindow as WeekDoc["errorWindow"] | undefined) },
    alerted: { ...(doc?.alerted as WeekDoc["alerted"] | undefined) },
  };
}

const add = (counts: Record<string, number>, key: string, n = 1) => {
  counts[key] = (counts[key] ?? 0) + n;
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
  const {
    store,
    pricing,
    now = Date.now,
    flushEveryMs = defaultFlushEveryMs,
    errorRateAlert = defaultErrorRateAlert,
  } = options;

  /**
   * Applies `change` to `week`'s document (this week's by default). Logs a
   * failure and answers `false`, never throws: monitoring must never fail the
   * request it watches.
   */
  async function fold(
    what: string,
    change: (week: WeekDoc) => void,
    week = isoWeek(now()).week,
  ): Promise<boolean> {
    try {
      await store.update(`${usageCollection}/${week}`, (doc) => {
        const next = readWeek(week, doc);
        change(next);
        return { doc: next as unknown as StoreDocument, result: undefined };
      });
      return true;
    } catch (error) {
      logEvent("ERROR", "store_error", `Usage: could not record ${what}`, {
        operation: "usage_record",
        error: describeError(error),
      });
      return false;
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

  /** Counts waiting to be written, per week, so a batch lands in the week it was counted in. */
  const batches = new Map<string, Batch>();

  function batchOf(week: string): Batch {
    let batch = batches.get(week);
    if (!batch) batches.set(week, (batch = { refusals: {}, unknownGoogleHops: 0 }));
    return batch;
  }

  const thisWeeksBatch = () => batchOf(isoWeek(now()).week);

  async function flush(): Promise<void> {
    const pending = [...batches];
    batches.clear();
    await Promise.all(
      pending.map(async ([week, { refusals, unknownGoogleHops }]) => {
        const written = await fold(
          "a batch of refused requests",
          ({ chat, mcp }) => {
            for (const [outcome, n] of Object.entries(refusals)) {
              chat.requests += n;
              add(chat.outcomes, outcome, n);
            }
            mcp.unknownGoogleHops += unknownGoogleHops;
          },
          week,
        );
        if (written) return;
        // Kept for the next batch, with whatever was counted meanwhile.
        const kept = batchOf(week);
        for (const [outcome, n] of Object.entries(refusals)) add(kept.refusals, outcome, n);
        kept.unknownGoogleHops += unknownGoogleHops;
      }),
    );
  }

  const timer = setInterval(() => void flush(), flushEveryMs);
  // Never what keeps the process alive: shutdown writes the rest with `close`.
  timer.unref();

  async function readStats(t: number): Promise<WeekStats> {
    const { week, startsAt } = isoWeek(t);
    const doc = await store.update(`${usageCollection}/${week}`, (d) => ({ result: d }));
    return summarize(readWeek(week, doc), startsAt);
  }

  return {
    async recordChat({ outcome, usage, totalMs, firstTextMs, modelCalls = 0 }) {
      logEvent("INFO", "chat_request", `Chat request: ${outcome}`, {
        outcome,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: usage ? usageCostUsd(usage, pricing) : 0,
        totalMs: totalMs ?? null,
        firstTextMs: firstTextMs ?? null,
        modelCalls,
      });
      if (refusedOutcomes.includes(outcome)) {
        add(thisWeeksBatch().refusals, outcome);
        return;
      }
      const t = now();
      const { week } = isoWeek(t);
      // What the error-rate watch saw, in the update that was written.
      let rate: ErrorRateChange | undefined;
      const written = await fold(`a chat request (${outcome})`, (doc) => {
        const { chat } = doc;
        chat.requests++;
        add(chat.outcomes, outcome);
        if (usage) {
          chat.inputTokens += usage.inputTokens;
          chat.outputTokens += usage.outputTokens;
          chat.costUsd += usageCostUsd(usage, pricing);
        }
        if (totalMs !== undefined) add(chat.totalMs, bucketOf(totalMs));
        if (firstTextMs !== undefined) add(chat.firstTextMs, bucketOf(firstTextMs));
        rate = countStreamed(doc, t, outcome.startsWith("error:"), errorRateAlert);
      }, week);
      if (written && rate) logErrorRate(week, rate);
    },
    async recordMcp() {
      await fold("an MCP request", ({ mcp }) => {
        mcp.requests++;
      });
    },
    countUnknownGoogleHop() {
      thisWeeksBatch().unknownGoogleHops++;
    },
    flush,
    async close() {
      clearInterval(timer);
      await flush();
    },
    async stats() {
      await flush();
      const t = now();
      const [current, previous] = await Promise.all([readStats(t), readStats(t - 7 * day)]);
      return { current, previous };
    },
  };
}
