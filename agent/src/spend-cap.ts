// Monthly spend cap on model usage. When the month's estimated spend reaches
// the budget, the chat answers `503 unavailable` without calling the model;
// MCP tools (no model cost) keep working.
//
// Check and record race: a chat request streams for seconds, and its cost is
// only known at the end. So each request first RESERVES its worst-case cost
// (`reserve`): it is refused if that doesn't fit in what's left under the
// spend cap, and the reservation stays while it runs, so concurrent requests
// can't all slip in under the same remaining room. Its model calls then
// RECORD their actual usage against the reservation, and `settle` releases
// whatever was reserved but not spent. Actual usage is always charged in full, even past the
// reservation (the worst-case input is an estimate).
//
// The running total lives in a `DocumentStore`, one document per UTC month
// (`spend/<YYYY-MM>`): with Firestore it is shared by every Cloud Run
// instance and survives cold starts; `createMemorySpendCap` keeps it in this
// process, for local development and tests. Each reservation expires after
// `reservationTtlMs`, so a request whose instance died before settling doesn't
// keep its worst case reserved for the rest of the month; what it spent stays
// charged. (The store keeps the reservations under `holds`.)
//
// Alert events (README, "Logs and alert events"): `spend_threshold` when the
// month's spend first reaches 50% and 80% of the budget, `spend_cap_reached`
// when the cap first refuses a request. Each fires once per month: the month's
// document notes it under `alerted`, in the same atomic update that crossed
// it, so it holds across instances and cold starts.
import { randomUUID } from "node:crypto";
import { createMemoryDocumentStore, type DocumentStore, type StoreChange, type StoreDocument } from "./document-store";
import { describeError, logEvent } from "./log";
import type { Usage } from "./model";
import { usageCostUsd, worstCaseCostUsd, type Pricing } from "./pricing";

/**
 * Spend held for one running request. Both methods are best effort: a store
 * failure is logged, never thrown, as the visitor's answer is already
 * streaming. What can't be settled is released when the reservation expires.
 */
export interface SpendReservation {
  /** Charges the actual usage of one model call. Never throws. */
  record(usage: Usage): Promise<void>;
  /** Ends the request: releases what was reserved and not spent. Idempotent. Never throws. */
  settle(): Promise<void>;
}

export type SpendCapStatus =
  | { exhausted: false; reservation: SpendReservation }
  | { exhausted: true; /** ISO time the spend cap resets (next UTC month). */ resetsAt: string };

export interface SpendCap {
  /**
   * Reserves `worstCase` (the most a request may spend) if the spend cap has
   * room for it this month; otherwise reports the spend cap as reached.
   */
  reserve(worstCase: Usage): Promise<SpendCapStatus>;
}

export type SpendCapOptions = {
  /** Monthly budget in USD; 0 disables the chat. */
  budgetUsd: number;
  pricing: Pricing;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /**
   * How long a reservation lasts if never settled; longer than any request
   * may run. Defaults to 15 minutes (Cloud Run's request timeout is 5).
   */
  reservationTtlMs?: number;
};

/** Sums of small floats, without the binary noise. */
const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** `YYYY-MM` of the UTC month containing `t`. */
const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);

const nextMonthStart = (t: number) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
};

/** Collection of the monthly spend documents. */
export const spendCollection = "spend";

/** Shares of the budget whose crossing logs `spend_threshold`, in percent. */
export const spendThresholdsPercent = [50, 80] as const;

/**
 * A month's spend: what was charged, the reservations of the requests running
 * (`holds`), and the alert events already logged this month (`alerted`, also
 * written by the provider-limit watch).
 */
export type MonthSpend = {
  spentUsd: number;
  holds: Record<string, { usd: number; expireAt: Date }>;
  alerted: Record<string, boolean>;
};

export function readMonth(doc: StoreDocument | undefined): MonthSpend {
  return {
    spentUsd: Number(doc?.spentUsd ?? 0),
    holds: (doc?.holds ?? {}) as MonthSpend["holds"],
    alerted: { ...(doc?.alerted as MonthSpend["alerted"] | undefined) },
  };
}

/** The `spend/<YYYY-MM>` document of the month containing `t`. */
export const spendPath = (t: number) => `${spendCollection}/${monthKey(t)}`;

/** Spend cap over a shared store: every instance draws on the same monthly budget. */
export function createStoreSpendCap(
  options: SpendCapOptions & { store: DocumentStore },
): SpendCap {
  const { store, budgetUsd, pricing, now = Date.now, reservationTtlMs = 15 * 60_000 } = options;

  return {
    async reserve(worstCase) {
      const t = now();
      const path = spendPath(t);
      const id = randomUUID();
      const costUsd = worstCaseCostUsd(worstCase, pricing);
      const resetsAt = nextMonthStart(t).toISOString();

      type Reserved = SpendCapStatus & { firstRefusal?: { spentUsd: number } };
      const status = await store.update(path, (doc): StoreChange<Reserved> => {
        const month = readMonth(doc);
        const holds = Object.fromEntries(
          Object.entries(month.holds).filter(([, hold]) => hold.expireAt.getTime() > t),
        );
        const committed =
          month.spentUsd + Object.values(holds).reduce((sum, hold) => sum + hold.usd, 0);
        if (committed >= budgetUsd || committed + costUsd > budgetUsd) {
          const refused = { exhausted: true as const, resetsAt };
          // Only the first refusal of the month writes: to note the alert.
          if (month.alerted.spend_cap_reached) return { result: refused };
          return {
            doc: { ...month, alerted: { ...month.alerted, spend_cap_reached: true } },
            result: { ...refused, firstRefusal: { spentUsd: month.spentUsd } },
          };
        }
        holds[id] = { usd: costUsd, expireAt: new Date(t + reservationTtlMs) };
        return {
          doc: { ...month, holds },
          result: { exhausted: false, reservation: reservation(path, id) },
        };
      });
      if (!status.exhausted) return status;
      if (status.firstRefusal) {
        logEvent("ERROR", "spend_cap_reached", "Spend cap reached: the chat is closed until the month ends", {
          month: monthKey(t),
          spentUsd: roundUsd(status.firstRefusal.spentUsd),
          budgetUsd,
          resetsAt,
        });
      }
      return { exhausted: true, resetsAt };
    },
  };

  function reservation(path: string, id: string): SpendReservation {
    let settled = false;
    // Once a usage couldn't be recorded, the reservation stays until it
    // expires: it covers that call's cost, which would otherwise go uncharged.
    let unrecorded = false;
    return {
      // Charged to the month the request started in.
      async record(usage) {
        const usd = usageCostUsd(usage, pricing);
        try {
          const crossed = await store.update(path, (doc) => {
            const month = readMonth(doc);
            const hold = month.holds[id];
            if (hold) hold.usd = Math.max(0, hold.usd - usd);
            const spentUsd = month.spentUsd + usd;
            const crossed = spendThresholdsPercent.filter(
              (percent) =>
                budgetUsd > 0 &&
                spentUsd >= (budgetUsd * percent) / 100 &&
                !month.alerted[`spend_threshold_${percent}`],
            );
            const alerted = { ...month.alerted };
            for (const percent of crossed) alerted[`spend_threshold_${percent}`] = true;
            return { doc: { ...month, spentUsd, alerted }, result: { crossed, spentUsd } };
          });
          for (const percent of crossed.crossed) {
            logEvent("WARNING", "spend_threshold", `Spend reached ${percent}% of the monthly cap`, {
              thresholdPercent: percent,
              month: path.slice(spendCollection.length + 1),
              spentUsd: roundUsd(crossed.spentUsd),
              budgetUsd,
            });
          }
        } catch (error) {
          // Not rethrown: the visitor's answer is already streaming.
          unrecorded = true;
          logEvent("ERROR", "store_error", `Spend cap: could not record $${usd} of usage`, {
            operation: "spend_record",
            costUsd: usd,
            error: describeError(error),
          });
        }
      },
      async settle() {
        if (settled || unrecorded) return;
        settled = true;
        try {
          await store.update(path, (doc) => {
            const month = readMonth(doc);
            if (!(id in month.holds)) return { result: undefined };
            delete month.holds[id];
            return { doc: month, result: undefined };
          });
        } catch (error) {
          // Not rethrown, like `record`: the reservation is released when it expires.
          logEvent("ERROR", "store_error", "Spend cap: could not settle a reservation", {
            operation: "spend_settle",
            error: describeError(error),
          });
        }
      },
    };
  }
}

/** Spend cap kept in this process: per instance, and lost on restart. */
export function createMemorySpendCap(options: SpendCapOptions): SpendCap {
  return createStoreSpendCap({ ...options, store: createMemoryDocumentStore() });
}
