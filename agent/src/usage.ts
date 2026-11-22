// Usage stats: weekly aggregates served by `GET /stats`, and the
// `chat_error_rate` alert's window, in one `usage/<YYYY-Www>` document per
// week. What is recorded, batching and the document's shape:
// docs/usage-stats.md; the alert: docs/logs-and-alerts.md.
//
// Every request's usage joins a batch per week, written only inside a request
// (`flushEveryMs`, before `/stats` reads, and in `close`), never by a timer:
// Cloud Run throttles the CPU outside requests. Recording is best effort: a failure is logged and
// swallowed, never failing the request being recorded. Latency is kept as
// histogram buckets, so percentiles need no samples; the alert's state is
// noted under `alerted` in the same atomic update that crosses it. Every chat request
// recorded is also logged, as one `chat_request` line.
import type { TokenUsage } from "../../src/shared/chat-contract";
import type {
  ChatOutcome,
  LatencyPercentiles,
  StatsResponse,
  WeekStats,
} from "../../src/shared/stats-contract";
import type { DocumentStore, StoreDocument } from "./document-store";
import { logEvent, logStoreError } from "./log";
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

/**
 * What a `chat_request` line can report: a usage outcome, or a request the
 * usage stats don't record (malformed `http_400`, oversized `http_413`; a
 * store failure's `http_503` is a usage outcome already).
 */
export type ChatRequestOutcome = ChatOutcome | "http_400" | "http_413";

/** The fields of one `chat_request` line (docs/logs-and-alerts.md). */
type ChatRequestLog = {
  outcome: ChatRequestOutcome;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  totalMs: number | null;
  firstTextMs: number | null;
  modelCalls: number;
};

/**
 * Logs one chat request as its `chat_request` line. `pricing` estimates the
 * cost of its usage; a request with no usage costs nothing.
 */
export function logChatRequest(
  { outcome, usage, totalMs, firstTextMs, modelCalls = 0 }: Omit<ChatRecord, "outcome"> & {
    outcome: ChatRequestOutcome;
  },
  pricing?: Pricing,
): void {
  const fields: ChatRequestLog = {
    outcome,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costUsd: usage && pricing ? usageCostUsd(usage, pricing) : 0,
    totalMs: totalMs ?? null,
    firstTextMs: firstTextMs ?? null,
    modelCalls,
  };
  logEvent("INFO", "chat_request", `Chat request: ${outcome}`, fields);
}

export interface UsageRecorder {
  /**
   * Logs one chat request (`chat_request`) and counts it in the next batch,
   * and writes the batch if it is due. Never throws.
   */
  recordChat(record: ChatRecord): Promise<void>;
  /**
   * Counts one MCP request in the next batch, and writes the batch if it is
   * due. Never throws.
   */
  recordMcp(): Promise<void>;
  /**
   * Counts one `/mcp` request whose right-most hop is a Google address
   * outside the user-triggered fetchers ranges, in the next batch.
   */
  countUnknownGoogleHop(): void;
  /** Writes the batched counts. Never throws: a batch that fails is kept. */
  flush(): Promise<void>;
  /** Writes what is left, for shutdown. */
  close(): Promise<void>;
  /** This week's and the previous week's aggregates, batched counts written first. */
  stats(): Promise<StatsResponse>;
}

export type UsageOptions = {
  store: DocumentStore;
  pricing: Pricing;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /**
   * How long after a batch is written the next one is due, in ms; the next
   * request that records usage then writes it.
   */
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

/** Default batch interval: well inside `/stats`' cache. */
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
  /**
   * Streamed chat requests and their errors per 10-minute bucket, keyed by
   * its start (ms). Absent until the week's first streamed request, which
   * starts it from the previous week's (`ErrorWindowTail`).
   */
  errorWindow?: Record<string, { streamed: number; errors: number }>;
  /** Alert events in effect: `chat_error_rate` while the rate is above its threshold. */
  alerted: Record<string, boolean>;
};

/** A chat request that ran, waiting for the next batch, with when it was recorded. */
type PendingChat = { record: ChatRecord; t: number };

/** Counts waiting for the next batch, of one week. */
type Batch = {
  refusals: Record<string, number>;
  chats: PendingChat[];
  mcpRequests: number;
  unknownGoogleHops: number;
};

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
    ...(doc?.errorWindow !== undefined && {
      errorWindow: { ...(doc.errorWindow as WeekDoc["errorWindow"]) },
    }),
    alerted: { ...(doc?.alerted as WeekDoc["alerted"] | undefined) },
  };
}

/** What a week's error window starts from: the end of the previous week's. */
type ErrorWindowTail = Pick<WeekDoc, "errorWindow"> & { alerted: boolean };

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
 * Counts one streamed request in the week's error window (started from
 * `tail` if the week has none yet), prunes buckets past the hour, and flips
 * `alerted.chat_error_rate` if the hour's rate crossed the threshold either
 * way.
 */
function countStreamed(
  week: WeekDoc,
  t: number,
  failed: boolean,
  alert: ErrorRateAlert,
  tail: ErrorWindowTail,
): ErrorRateChange {
  if (week.errorWindow === undefined) {
    week.errorWindow = { ...tail.errorWindow };
    if (tail.alerted) week.alerted = { ...week.alerted, chat_error_rate: true };
  }
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
      logStoreError("usage_record", `Usage: could not record ${what}`, error);
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
    if (!batch) {
      batches.set(week, (batch = { refusals: {}, chats: [], mcpRequests: 0, unknownGoogleHops: 0 }));
    }
    return batch;
  }

  const thisWeeksBatch = () => batchOf(isoWeek(now()).week);

  /** The previous week's error window, per week: read once by each instance. */
  const tails = new Map<string, Promise<ErrorWindowTail>>();

  function tailBefore(week: string, t: number): Promise<ErrorWindowTail> {
    let tail = tails.get(week);
    if (!tail) {
      const previous = isoWeek(t - 7 * day).week;
      tail = store
        .update(`${usageCollection}/${previous}`, (doc) => ({ result: readWeek(previous, doc) }))
        .then(({ errorWindow, alerted }) => ({ errorWindow, alerted: Boolean(alerted.chat_error_rate) }));
      tails.clear(); // only this week's is ever needed again
      tails.set(week, tail);
      // Not kept when it fails: the next request tries again.
      tail.catch(() => tails.delete(week));
    }
    return tail;
  }

  /** When the last batch was written (or started to be); the first one is due at once. */
  let flushedAt = -Infinity;

  async function flush(): Promise<void> {
    flushedAt = now();
    const pending = [...batches];
    batches.clear();
    await Promise.all(
      pending.map(async ([week, { refusals, chats, mcpRequests, unknownGoogleHops }]) => {
        let tail: ErrorWindowTail = { alerted: false };
        if (chats.length > 0) {
          try {
            tail = await tailBefore(week, chats[0].t);
          } catch {
            // The window then starts afresh, as with no previous week. Not
            // logged: a store that fails this read fails the update below, which is.
          }
        }
        // What the error-rate watch saw, in the update that was written.
        let changes: ErrorRateChange[] = [];
        const written = await fold(
          "a batch of counted requests",
          (doc) => {
            const { chat, mcp } = doc;
            for (const [outcome, n] of Object.entries(refusals)) {
              chat.requests += n;
              add(chat.outcomes, outcome, n);
            }
            changes = chats.map(({ record, t }) => foldChat(doc, record, t, tail));
            mcp.requests += mcpRequests;
            mcp.unknownGoogleHops += unknownGoogleHops;
          },
          week,
        );
        if (written) {
          for (const change of changes) logErrorRate(week, change);
          return;
        }
        // Kept for the next batch, with whatever was counted meanwhile.
        const kept = batchOf(week);
        for (const [outcome, n] of Object.entries(refusals)) add(kept.refusals, outcome, n);
        kept.chats.unshift(...chats);
        kept.mcpRequests += mcpRequests;
        kept.unknownGoogleHops += unknownGoogleHops;
      }),
    );
  }

  /** Writes the batch inside the request recording usage, once it is due. */
  async function flushIfDue(): Promise<void> {
    if (batches.size > 0 && now() - flushedAt >= flushEveryMs) await flush();
  }

  async function readStats(t: number): Promise<WeekStats> {
    const { week, startsAt } = isoWeek(t);
    const doc = await store.update(`${usageCollection}/${week}`, (d) => ({ result: d }));
    return summarize(readWeek(week, doc), startsAt);
  }

  /** Folds one chat request that ran into its week's document, and counts it in the error window. */
  function foldChat(doc: WeekDoc, record: ChatRecord, t: number, tail: ErrorWindowTail) {
    const { outcome, usage, totalMs, firstTextMs } = record;
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
    return countStreamed(doc, t, outcome.startsWith("error:"), errorRateAlert, tail);
  }

  return {
    async recordChat(record) {
      logChatRequest(record, pricing);
      if (refusedOutcomes.includes(record.outcome)) add(thisWeeksBatch().refusals, record.outcome);
      else thisWeeksBatch().chats.push({ record, t: now() });
      await flushIfDue();
    },
    async recordMcp() {
      thisWeeksBatch().mcpRequests++;
      await flushIfDue();
    },
    countUnknownGoogleHop() {
      thisWeeksBatch().unknownGoogleHops++;
    },
    flush,
    close: flush,
    async stats() {
      await flush();
      const t = now();
      const [current, previous] = await Promise.all([readStats(t), readStats(t - 7 * day)]);
      return { current, previous };
    },
  };
}
