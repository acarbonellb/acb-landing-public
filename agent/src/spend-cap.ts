// Monthly spend cap on model usage. When the month's estimated spend reaches
// the budget, the chat answers `503 unavailable` without calling the model;
// MCP tools (no model cost) keep working.
//
// Check and record race: a chat request streams for seconds, and its cost is
// only known at the end. So each request first RESERVES its worst-case cost
// (`reserve`): it is refused if that doesn't fit in what's left, and the
// amount stays held while it runs, so concurrent requests can't all slip in
// under the same remaining budget. Its model calls then RECORD their actual
// usage against the reservation, and `settle` releases whatever was held but
// not spent. Actual usage is always charged in full, even past the
// reservation (the worst-case input is an estimate).
//
// The default store is in memory, so the running total is PER INSTANCE and
// is lost on restart: Cloud Run may run several instances (each allowed the
// full budget) and scales to zero (a cold start begins again at $0). Run
// Cloud Run with max-instances=1 and set a monthly spend limit in the
// Anthropic Console as the hard backstop. To make the cap global and
// durable, implement `SpendCap` over a shared store (e.g. a Firestore
// document `spend/<YYYY-MM>` updated in a transaction, or Redis
// `INCRBYFLOAT spend:<YYYY-MM>`) and inject it through `AppDeps`.
import type { Usage } from "./model";

/** USD per million tokens. */
export type Pricing = { inputUsdPerMTok: number; outputUsdPerMTok: number };

/** Spend held for one running request. */
export interface SpendReservation {
  /** Charges the actual usage of one model call. */
  record(usage: Usage): Promise<void>;
  /** Ends the request: releases what was held and not spent. Idempotent. */
  settle(): Promise<void>;
}

export type SpendCapStatus =
  | { exhausted: false; reservation: SpendReservation }
  | { exhausted: true; /** ISO time the budget renews (next UTC month). */ resetsAt: string };

export interface SpendCap {
  /**
   * Holds `worstCase` (the most a request may spend) if this month's budget
   * has room for it; otherwise reports the budget as exhausted.
   */
  reserve(worstCase: Usage): Promise<SpendCapStatus>;
}

export type SpendCapOptions = {
  /** Monthly budget in USD; 0 disables the chat. */
  budgetUsd: number;
  pricing: Pricing;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
};

export function usageCostUsd(usage: Usage, pricing: Pricing): number {
  return (
    (usage.inputTokens * pricing.inputUsdPerMTok +
      usage.outputTokens * pricing.outputUsdPerMTok) /
    1_000_000
  );
}

/** `YYYY-MM` of the UTC month containing `t`. */
const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);

const nextMonthStart = (t: number) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
};

export function createMemorySpendCap(options: SpendCapOptions): SpendCap {
  const { budgetUsd, pricing, now = Date.now } = options;
  let month = monthKey(now());
  let spentUsd = 0;
  let heldUsd = 0;

  function rollOver() {
    const key = monthKey(now());
    if (key !== month) {
      month = key;
      spentUsd = 0;
      heldUsd = 0;
    }
  }

  return {
    async reserve(worstCase) {
      const t = now();
      rollOver();
      const costUsd = usageCostUsd(worstCase, pricing);
      const committed = spentUsd + heldUsd;
      if (committed >= budgetUsd || committed + costUsd > budgetUsd) {
        return { exhausted: true, resetsAt: nextMonthStart(t).toISOString() };
      }
      heldUsd += costUsd;
      let leftUsd = costUsd;
      const release = (usd: number) => {
        heldUsd = Math.max(0, heldUsd - usd);
        leftUsd -= usd;
      };
      return {
        exhausted: false,
        reservation: {
          async record(usage) {
            rollOver();
            const usd = usageCostUsd(usage, pricing);
            spentUsd += usd;
            release(Math.min(usd, leftUsd));
          },
          async settle() {
            release(leftUsd);
          },
        },
      };
    },
  };
}
