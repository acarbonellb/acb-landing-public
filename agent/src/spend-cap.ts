// Monthly spend cap on model usage, one `spend/<YYYY-MM>` document per UTC
// month (docs/guardrails.md#monthly-spend-cap). A chat request's cost is only
// known once it ends, so it reserves its worst case first (`reserve`) and
// settles later (`spend-holds.ts`, shared with the daily quota): concurrent
// requests can't all slip in under the same remaining room.
// `createMemorySpendCap` keeps the total in this process, for local
// development and tests. Its alert events, `spend_threshold` and
// `spend_cap_reached`: docs/logs-and-alerts.md.
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
  /** Estimated spend allowed per UTC month, in USD; 0 disables the chat. */
  capUsd: number;
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

/** Shares of the cap whose crossing logs `spend_threshold`, in percent. */
export const spendThresholdsPercent = [50, 80] as const;

/** The spend cap's alert events, for the month starting at `month`. */
function spendAlerts(month: string, capUsd: number, resetsAt: string): SpendAlerts {
  return {
    thresholdsPercent: spendThresholdsPercent,
    onThreshold(percent, spentUsd) {
      logEvent("WARNING", "spend_threshold", `Spend reached ${percent}% of the monthly cap`, {
        thresholdPercent: percent,
        month,
        spentUsd,
        capUsd,
      });
    },
    onFirstRefusal(spentUsd) {
      logEvent("ERROR", "spend_cap_reached", "Spend cap reached: the chat is closed until the month ends", {
        month,
        spentUsd,
        capUsd,
        resetsAt,
      });
    },
  };
}

/** Spend cap over a shared store: every instance draws on the same monthly cap. */
export function createStoreSpendCap(
  options: SpendCapOptions & { store: DocumentStore },
): SpendCap {
  const { store, capUsd, pricing, now = Date.now, reservationTtlMs = defaultReservationTtlMs } = options;

  return {
    async reserve(worstCase) {
      const t = now();
      const resetsAt = nextMonthStart(t).toISOString();
      const reservation = await reserveSpend({
        store,
        path: spendPath(t),
        limitUsd: capUsd,
        costUsd: worstCaseCostUsd(worstCase, pricing),
        pricing,
        arrivedAt: t,
        reservationTtlMs,
        guard: "spend_cap",
        alerts: spendAlerts(monthKey(t), capUsd, resetsAt),
      });
      return reservation ? { exhausted: false, reservation } : { exhausted: true, resetsAt };
    },
  };
}

/** Spend cap kept in this process: per instance, and lost on restart. */
export function createMemorySpendCap(options: SpendCapOptions): SpendCap {
  return createStoreSpendCap({ ...options, store: createMemoryDocumentStore() });
}
