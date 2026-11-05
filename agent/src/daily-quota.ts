// Daily quota: the estimated model spend one rate-limit key may use per UTC
// day, on top of the per-minute rate limit and the monthly spend cap, so one
// source can't drain the month's budget. It counts spend, not requests: each
// chat request reserves its worst-case cost here too (it grows with the
// conversation sent), its model calls are charged, and the rest is released,
// with the spend cap's reservation mechanics (`spend-holds.ts`). A request
// whose worst case doesn't fit is refused like a rate-limit refusal, until
// the next UTC midnight.
//
// One document per key and UTC day, `dailySpend/<YYYY-MM-DD>:<key>` (the
// key URL-encoded), in the shared store when one is configured, so every
// instance counts against the same quota. Each carries `expireAt` (the end of
// its day) for a Firestore TTL policy to delete it.
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import type { Usage } from "./model";
import { worstCaseCostUsd, type Pricing } from "./pricing";
import { defaultReservationTtlMs, reserveSpend, type SpendReservation } from "./spend-holds";

export type DailyQuotaStatus =
  | { exceeded: false; reservation: SpendReservation }
  | {
      exceeded: true;
      /** Whole seconds until the quota resets (next UTC midnight). */
      retryAfterSeconds: number;
      /** ISO time the quota resets. */
      resetsAt: string;
    };

export interface DailyQuota {
  /** Reserves `worstCase` against `key`'s quota for today, if it fits. */
  reserve(key: string, worstCase: Usage): Promise<DailyQuotaStatus>;
}

export type DailyQuotaOptions = {
  /** Estimated spend per rate-limit key per UTC day, in USD; 0 refuses every chat request. */
  quotaUsd: number;
  pricing: Pricing;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /** How long a reservation lasts if never settled (see `spend-holds.ts`). */
  reservationTtlMs?: number;
};

/** Collection of the daily spend documents, one per key and day. */
export const dailySpendCollection = "dailySpend";

const nextDayStart = (t: number) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
};

/** Daily quota over a shared store: every instance counts against the same quota. */
export function createStoreDailyQuota(
  options: DailyQuotaOptions & { store: DocumentStore },
): DailyQuota {
  const { store, quotaUsd, pricing, now = Date.now, reservationTtlMs = defaultReservationTtlMs } =
    options;
  return {
    async reserve(key, worstCase) {
      const t = now();
      const day = new Date(t).toISOString().slice(0, 10);
      const resetsAt = nextDayStart(t);
      const reservation = await reserveSpend({
        store,
        path: `${dailySpendCollection}/${day}:${encodeURIComponent(key)}`,
        budgetUsd: quotaUsd,
        costUsd: worstCaseCostUsd(worstCase, pricing),
        pricing,
        t,
        reservationTtlMs,
        expireAt: resetsAt,
        label: "Daily quota",
      });
      if (reservation) return { exceeded: false, reservation };
      return {
        exceeded: true,
        retryAfterSeconds: Math.max(1, Math.ceil((resetsAt.getTime() - t) / 1000)),
        resetsAt: resetsAt.toISOString(),
      };
    },
  };
}

/**
 * Daily quota kept in this process: per instance, and lost on restart. Past
 * days' documents stay in memory until then (one small one per key and day).
 */
export function createMemoryDailyQuota(options: DailyQuotaOptions): DailyQuota {
  return createStoreDailyQuota({ ...options, store: createMemoryDocumentStore() });
}
