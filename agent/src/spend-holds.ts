// The reservation mechanics shared by the monthly spend cap (`spend-cap.ts`)
// and the daily quota (`daily-quota.ts`): one spend document per limit and
// period, holding what was charged (`spentUsd`) and the reservations of the
// requests running (`holds`, each with its worst case and `expireAt`).
//
// A chat request RESERVES its worst-case cost if it fits under the limit,
// keeps the actual usage of its model calls in memory while it runs, and
// SETTLES once it ends: the hold is replaced by what the request actually
// spent. So a request writes each document twice, to reserve and to settle,
// whatever number of model calls it makes. Actual usage is always charged in
// full, even past the reservation (the worst-case input is an estimate).
//
// Each reservation expires after its TTL. A hold still there by then was
// never settled (its instance died, or the settle couldn't be written): the
// next reservation on the document charges it at its worst case, as what the
// request actually spent was only ever in that instance's memory. So a lost
// settle never under-counts spend; it over-counts by what the request didn't
// use.
//
// A limit can also have alert events (`SpendAlerts`, the spend cap's;
// docs/logs-and-alerts.md, "Alert events"): a share of the limit first reached, and its first
// refusal. Each fires once per document (so per period): it is noted under
// `alerted`, in the same atomic update that crossed it (a settle, or the
// reservation that charges an expired hold), so it holds across instances and
// cold starts.
import { randomUUID } from "node:crypto";
import type { DocumentStore, StoreChange, StoreDocument } from "./document-store";
import { logStoreError } from "./log";
import type { Usage } from "./model";
import { usageCostUsd, type Pricing } from "./pricing";

/**
 * Spend held for one running request, until it settles. Settling is best
 * effort: a store failure is logged, never thrown, as the visitor's answer
 * has already streamed. What can't be settled is charged at its worst case
 * once the reservation expires.
 */
export interface SpendReservation {
  /**
   * Ends the request: charges `usage`, the actual usage of all its model
   * calls, in place of its hold. Only the first call counts. Never throws.
   */
  settle(usage: Usage): Promise<void>;
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
    holds: { ...(doc?.holds as Spend["holds"] | undefined) },
    alerted: { ...(doc?.alerted as Spend["alerted"] | undefined) },
  };
}

/**
 * Alert events of a limit, each logged once per document. Noted under
 * `alerted` as `threshold_<percent>` and `refused`.
 */
export type SpendAlerts = {
  /** Shares of the limit, in percent, whose first crossing calls `onThreshold`. */
  thresholdsPercent: readonly number[];
  /** Called once the update that crossed `percent` is written. */
  onThreshold(percent: number, spentUsd: number): void;
  /** Called once the first refusal is noted. */
  onFirstRefusal(spentUsd: number): void;
};

/** Sums of small floats, without the binary noise. */
export const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** The two spend limits a reservation is held against, as log lines name them. */
export type SpendGuard = "spend_cap" | "daily_quota";

const guardNames: Record<SpendGuard, string> = { spend_cap: "Spend cap", daily_quota: "Daily quota" };

export type ReserveOptions = {
  store: DocumentStore;
  /** The spend document of this limit and period. */
  path: string;
  /** The most the period may spend, in USD. */
  limitUsd: number;
  /** The request's worst-case cost. */
  costUsd: number;
  pricing: Pricing;
  /** When the request arrived (ms since epoch). */
  arrivedAt: number;
  reservationTtlMs: number;
  /** Written on the document, for a Firestore TTL policy to delete it once its period is over. */
  expireAt?: Date;
  /** Which limit this is, in log lines. */
  guard: SpendGuard;
  alerts?: SpendAlerts;
};

/**
 * Charges the holds of `spend` that expired by `t` at their worst case (see
 * the top of this file), and takes them off.
 */
function chargeExpiredHolds(spend: Spend, t: number): void {
  for (const [id, hold] of Object.entries(spend.holds)) {
    if (hold.expireAt.getTime() > t) continue;
    spend.spentUsd += hold.usd;
    Reflect.deleteProperty(spend.holds, id);
  }
}

/**
 * The shares of `limitUsd` that `spend` reaches and doesn't note yet, now
 * noted under `spend.alerted`.
 */
function noteCrossedThresholds(spend: Spend, limitUsd: number, alerts: SpendAlerts | undefined): number[] {
  if (!alerts || limitUsd <= 0) return [];
  const crossed = alerts.thresholdsPercent.filter(
    (percent) =>
      spend.spentUsd >= (limitUsd * percent) / 100 && !spend.alerted[`threshold_${percent}`],
  );
  for (const percent of crossed) spend.alerted[`threshold_${percent}`] = true;
  return crossed;
}

/** What an update of a spend document reports, for its alert events. */
type Charged = { crossed: number[]; spentUsd: number };

function fireThresholds(alerts: SpendAlerts | undefined, { crossed, spentUsd }: Charged) {
  for (const percent of crossed) alerts?.onThreshold(percent, roundUsd(spentUsd));
}

/**
 * Reserves `costUsd` if it fits in what's left of `limitUsd` (what was spent
 * plus the live holds); `null` if it doesn't. Expired holds are charged first.
 */
export async function reserveSpend(options: ReserveOptions): Promise<SpendReservation | null> {
  const { store, path, limitUsd, costUsd, arrivedAt, reservationTtlMs, expireAt, alerts } = options;
  const id = randomUUID();
  type Reserved = Charged & { reservation: SpendReservation | null; firstRefusal?: boolean };
  const reserved = await store.update(path, (doc): StoreChange<Reserved> => {
    const spend = readSpend(doc);
    chargeExpiredHolds(spend, arrivedAt);
    // What an expired hold is charged can cross a threshold.
    const crossed = noteCrossedThresholds(spend, limitUsd, alerts);
    const committed = spend.spentUsd + Object.values(spend.holds).reduce((sum, hold) => sum + hold.usd, 0);
    const write = (result: Reserved): StoreChange<Reserved> => ({
      doc: { ...doc, ...spend, ...(expireAt && { expireAt }) },
      result,
    });
    if (committed >= limitUsd || committed + costUsd > limitUsd) {
      // Only the first refusal writes: to note its alert. Expired holds need
      // no write of their own: they count the same until a write charges them.
      if (!alerts || spend.alerted.refused) {
        return { result: { reservation: null, crossed: [], spentUsd: spend.spentUsd } };
      }
      spend.alerted.refused = true;
      return write({ reservation: null, crossed, spentUsd: spend.spentUsd, firstRefusal: true });
    }
    spend.holds[id] = { usd: costUsd, expireAt: new Date(arrivedAt + reservationTtlMs) };
    return write({ reservation: reservation(options, id), crossed, spentUsd: spend.spentUsd });
  });
  fireThresholds(alerts, reserved);
  if (reserved.firstRefusal) alerts?.onFirstRefusal(roundUsd(reserved.spentUsd));
  return reserved.reservation;
}

function reservation(
  { store, path, pricing, guard, limitUsd, costUsd, alerts }: ReserveOptions,
  id: string,
): SpendReservation {
  let settled = false;
  return {
    // Charged to the period the request started in.
    async settle(usage) {
      if (settled) return;
      settled = true;
      const usd = usageCostUsd(usage, pricing);
      try {
        const charged = await store.update(path, (doc): StoreChange<Charged> => {
          const spend = readSpend(doc);
          const held = id in spend.holds;
          // No hold: it expired and was charged at its worst case (`costUsd`).
          // Only an overrun past that is left to charge.
          const charge = held ? usd : Math.max(0, usd - costUsd);
          if (!held && charge === 0) return { result: { crossed: [], spentUsd: spend.spentUsd } };
          Reflect.deleteProperty(spend.holds, id);
          spend.spentUsd += charge;
          const crossed = noteCrossedThresholds(spend, limitUsd, alerts);
          return { doc: { ...doc, ...spend }, result: { crossed, spentUsd: spend.spentUsd } };
        });
        fireThresholds(alerts, charged);
      } catch (error) {
        // Not rethrown: the visitor's answer has already streamed. The hold
        // stays, and is charged at its worst case once it expires.
        logStoreError("spend_settle", `${guardNames[guard]}: could not settle $${usd} of usage`, error, {
          guard,
          costUsd: usd,
        });
      }
    },
  };
}

/** One reservation over several limits: the request is settled in all of them. */
export function combineReservations(...reservations: SpendReservation[]): SpendReservation {
  return {
    async settle(usage) {
      await Promise.all(reservations.map((r) => r.settle(usage)));
    },
  };
}
