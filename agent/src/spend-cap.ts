// Monthly spend cap on model usage. When the month's estimated spend reaches
// the budget, the chat answers `503 unavailable` without calling the model;
// MCP tools (no model cost) keep working.
//
// Check and record race: a chat request streams for seconds, and its cost is
// only known at the end. So each request first RESERVES its worst-case cost
// (`reserve`): it is refused if that doesn't fit in what's left under the
// spend cap, and the reservation stays while it runs, so concurrent requests
// can't all slip in under the same remaining room. Its model calls then
// RECORD their actual usage against the reservation, and settling releases
// what wasn't spent (`spend-holds.ts`, shared with the daily quota).
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
// when the cap first refuses a request. Each fires once per month, noted in
// the month's document (`spend-holds.ts`).
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { logEvent } from "./log";
import type { Usage } from "./model";
import { worstCaseCostUsd, type Pricing } from "./pricing";
import {
  defaultReservationTtlMs,
  reserveSpend,
  type SpendAlerts,
  type SpendReservation,
} from "./spend-holds";

export type { SpendReservation };

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

/** `YYYY-MM` of the UTC month containing `t`. */
const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);

const nextMonthStart = (t: number) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
};

/** Collection of the monthly spend documents. */
export const spendCollection = "spend";

/** The `spend/<YYYY-MM>` document of the month containing `t`. */
export const spendPath = (t: number) => `${spendCollection}/${monthKey(t)}`;

/** Shares of the budget whose crossing logs `spend_threshold`, in percent. */
export const spendThresholdsPercent = [50, 80] as const;

/** The spend cap's alert events, for the month starting at `month`. */
function spendAlerts(month: string, budgetUsd: number, resetsAt: string): SpendAlerts {
  return {
    thresholdsPercent: spendThresholdsPercent,
    onThreshold(percent, spentUsd) {
      logEvent("WARNING", "spend_threshold", `Spend reached ${percent}% of the monthly cap`, {
        thresholdPercent: percent,
        month,
        spentUsd,
        budgetUsd,
      });
    },
    onFirstRefusal(spentUsd) {
      logEvent("ERROR", "spend_cap_reached", "Spend cap reached: the chat is closed until the month ends", {
        month,
        spentUsd,
        budgetUsd,
        resetsAt,
      });
    },
  };
}

/** Spend cap over a shared store: every instance draws on the same monthly budget. */
export function createStoreSpendCap(
  options: SpendCapOptions & { store: DocumentStore },
): SpendCap {
  const { store, budgetUsd, pricing, now = Date.now, reservationTtlMs = defaultReservationTtlMs } = options;

  return {
    async reserve(worstCase) {
      const t = now();
      const resetsAt = nextMonthStart(t).toISOString();
      const reservation = await reserveSpend({
        store,
        path: spendPath(t),
        budgetUsd,
        costUsd: worstCaseCostUsd(worstCase, pricing),
        pricing,
        t,
        reservationTtlMs,
        label: "Spend cap",
        alerts: spendAlerts(monthKey(t), budgetUsd, resetsAt),
      });
      return reservation ? { exhausted: false, reservation } : { exhausted: true, resetsAt };
    },
  };
}

/** Spend cap kept in this process: per instance, and lost on restart. */
export function createMemorySpendCap(options: SpendCapOptions): SpendCap {
  return createStoreSpendCap({ ...options, store: createMemoryDocumentStore() });
}
