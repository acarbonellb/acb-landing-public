// Monthly spend cap on model usage. When the month's estimated spend reaches
// the budget, the chat answers `503 unavailable` without calling the model;
// MCP tools (no model cost) keep working.
//
// The default store is in memory, so the running total is PER INSTANCE and
// is lost on restart: Cloud Run may run several instances (each allowed the
// full budget) and scales to zero (a cold start begins again at $0). Keep the
// Cloud Run max-instances setting low and set a matching budget alert in the
// Anthropic Console / GCP billing as the real backstop. To make the cap
// global and durable, implement `SpendCap` over a shared store (e.g. a
// Firestore document `spend/<YYYY-MM>` incremented with `FieldValue.increment`,
// or Redis `INCRBYFLOAT spend:<YYYY-MM>`) and inject it through `AppDeps`.
import type { Usage } from "./model";

/** USD per million tokens. */
export type Pricing = { inputUsdPerMTok: number; outputUsdPerMTok: number };

export type SpendCapStatus =
  | { exhausted: false }
  | { exhausted: true; /** ISO time the budget renews (next UTC month). */ resetsAt: string };

export interface SpendCap {
  /** Whether this month's budget is used up. */
  check(): Promise<SpendCapStatus>;
  /** Adds the cost of one model call to this month's spend. */
  record(usage: Usage): Promise<void>;
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

  function current(t: number) {
    const key = monthKey(t);
    if (key !== month) {
      month = key;
      spentUsd = 0;
    }
  }

  return {
    async check() {
      const t = now();
      current(t);
      if (spentUsd < budgetUsd) return { exhausted: false };
      return { exhausted: true, resetsAt: nextMonthStart(t).toISOString() };
    },
    async record(usage) {
      current(now());
      spentUsd += usageCostUsd(usage, pricing);
    },
  };
}
