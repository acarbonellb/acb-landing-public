// The reservation mechanics shared by the monthly spend cap (`spend-cap.ts`)
// and the daily quota (`daily-quota.ts`): one spend document per budget and
// period, holding what was charged (`spentUsd`) and the reservations of the
// requests running (`holds`, each with its worst case and `expireAt`).
//
// A chat request RESERVES its worst-case cost if it fits under the budget,
// its model calls RECORD their actual usage against the reservation, and
// `settle` releases whatever was reserved but not spent. Actual usage is
// always charged in full, even past the reservation (the worst-case input is
// an estimate). Each reservation expires after its TTL, so a request whose
// instance died before settling doesn't keep its worst case reserved; what it
// spent stays charged.
//
// A budget can also have alert events (`SpendAlerts`; the spend cap's, README,
// "Logs and alert events"): a share of the budget first reached, and its first
// refusal. Each fires once per document (so per period): it is noted under
// `alerted`, in the same atomic update that crossed it, so it holds across
// instances and cold starts.
import { randomUUID } from "node:crypto";
import type { DocumentStore, StoreChange, StoreDocument } from "./document-store";
import { describeError, logEvent } from "./log";
import type { Usage } from "./model";
import { usageCostUsd, type Pricing } from "./pricing";

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

/** Default reservation TTL: longer than any request may run (Cloud Run's request timeout is 5 minutes). */
export const defaultReservationTtlMs = 15 * 60_000;

type Spend = {
  spentUsd: number;
  holds: Record<string, { usd: number; expireAt: Date }>;
  /** Alert events already fired for this document (`SpendAlerts`). */
  alerted: Record<string, boolean>;
};

function readSpend(doc: StoreDocument | undefined): Spend {
  return {
    spentUsd: Number(doc?.spentUsd ?? 0),
    holds: (doc?.holds ?? {}) as Spend["holds"],
    alerted: { ...(doc?.alerted as Spend["alerted"] | undefined) },
  };
}

/**
 * Alert events of a budget, each logged once per document. Noted under
 * `alerted` as `threshold_<percent>` and `refused`.
 */
export type SpendAlerts = {
  /** Shares of the budget, in percent, whose first crossing calls `onThreshold`. */
  thresholdsPercent: readonly number[];
  /** Called once the update that crossed `percent` is written. */
  onThreshold(percent: number, spentUsd: number): void;
  /** Called once the first refusal is noted. */
  onFirstRefusal(spentUsd: number): void;
};

/** Sums of small floats, without the binary noise. */
export const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

export type ReserveOptions = {
  store: DocumentStore;
  /** The spend document of this budget and period. */
  path: string;
  budgetUsd: number;
  /** The request's worst-case cost. */
  costUsd: number;
  pricing: Pricing;
  /** When the request arrived (ms since epoch). */
  t: number;
  reservationTtlMs: number;
  /** Written on the document, for a Firestore TTL policy to delete it once its period is over. */
  expireAt?: Date;
  /** Names the budget in log lines. */
  label: string;
  alerts?: SpendAlerts;
};

/**
 * Reserves `costUsd` if it fits in what's left of `budgetUsd` (what was spent
 * plus the live holds); `null` if it doesn't.
 */
export async function reserveSpend(options: ReserveOptions): Promise<SpendReservation | null> {
  const { store, path, budgetUsd, costUsd, t, reservationTtlMs, expireAt, alerts } = options;
  const id = randomUUID();
  type Reserved = { reservation: SpendReservation | null; firstRefusal?: { spentUsd: number } };
  const reserved = await store.update(path, (doc): StoreChange<Reserved> => {
    const spend = readSpend(doc);
    const holds = Object.fromEntries(
      Object.entries(spend.holds).filter(([, hold]) => hold.expireAt.getTime() > t),
    );
    const committed = spend.spentUsd + Object.values(holds).reduce((sum, hold) => sum + hold.usd, 0);
    if (committed >= budgetUsd || committed + costUsd > budgetUsd) {
      // Only the first refusal writes: to note its alert.
      if (!alerts || spend.alerted.refused) return { result: { reservation: null } };
      return {
        doc: { ...doc, alerted: { ...spend.alerted, refused: true } },
        result: { reservation: null, firstRefusal: { spentUsd: spend.spentUsd } },
      };
    }
    holds[id] = { usd: costUsd, expireAt: new Date(t + reservationTtlMs) };
    return {
      doc: { ...doc, spentUsd: spend.spentUsd, holds, ...(expireAt && { expireAt }) },
      result: { reservation: reservation(options, id) },
    };
  });
  if (reserved.firstRefusal) alerts?.onFirstRefusal(roundUsd(reserved.firstRefusal.spentUsd));
  return reserved.reservation;
}

/** The shares of `budgetUsd` that `spentUsd` reaches and `alerted` doesn't note yet. */
function crossedThresholds(spend: Spend, budgetUsd: number, alerts: SpendAlerts | undefined): number[] {
  if (!alerts || budgetUsd <= 0) return [];
  return alerts.thresholdsPercent.filter(
    (percent) =>
      spend.spentUsd >= (budgetUsd * percent) / 100 && !spend.alerted[`threshold_${percent}`],
  );
}

function reservation(
  { store, path, pricing, label, budgetUsd, alerts }: ReserveOptions,
  id: string,
): SpendReservation {
  let settled = false;
  // Once a usage couldn't be recorded, the reservation stays until it
  // expires: it covers that call's cost, which would otherwise go uncharged.
  let unrecorded = false;
  return {
    // Charged to the period the request started in.
    async record(usage) {
      const usd = usageCostUsd(usage, pricing);
      try {
        const charged = await store.update(path, (doc) => {
          const spend = readSpend(doc);
          const hold = spend.holds[id];
          if (hold) hold.usd = Math.max(0, hold.usd - usd);
          spend.spentUsd += usd;
          const crossed = crossedThresholds(spend, budgetUsd, alerts);
          for (const percent of crossed) spend.alerted[`threshold_${percent}`] = true;
          return {
            doc: {
              ...doc,
              spentUsd: spend.spentUsd,
              holds: spend.holds,
              ...(crossed.length && { alerted: spend.alerted }),
            },
            result: { crossed, spentUsd: spend.spentUsd },
          };
        });
        for (const percent of charged.crossed) alerts?.onThreshold(percent, roundUsd(charged.spentUsd));
      } catch (error) {
        // Not rethrown: the visitor's answer is already streaming.
        unrecorded = true;
        logEvent("ERROR", "store_error", `${label}: could not record $${usd} of usage`, {
          operation: "spend_record",
          budget: label,
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
          const spend = readSpend(doc);
          if (!(id in spend.holds)) return { result: undefined };
          delete spend.holds[id];
          return { doc: { ...doc, ...spend }, result: undefined };
        });
      } catch (error) {
        // Not rethrown, like `record`: the reservation is released when it expires.
        logEvent("ERROR", "store_error", `${label}: could not settle a reservation`, {
          operation: "spend_settle",
          budget: label,
          error: describeError(error),
        });
      }
    },
  };
}

/** One reservation over several budgets: each call is recorded, and the request settled, in all of them. */
export function combineReservations(...reservations: SpendReservation[]): SpendReservation {
  return {
    async record(usage) {
      await Promise.all(reservations.map((r) => r.record(usage)));
    },
    async settle() {
      await Promise.all(reservations.map((r) => r.settle()));
    },
  };
}
