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
import { randomUUID } from "node:crypto";
import type { DocumentStore, StoreChange, StoreDocument } from "./document-store";
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

type Spend = { spentUsd: number; holds: Record<string, { usd: number; expireAt: Date }> };

function readSpend(doc: StoreDocument | undefined): Spend {
  return {
    spentUsd: Number(doc?.spentUsd ?? 0),
    holds: (doc?.holds ?? {}) as Spend["holds"],
  };
}

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
};

/**
 * Reserves `costUsd` if it fits in what's left of `budgetUsd` (what was spent
 * plus the live holds); `null` if it doesn't.
 */
export function reserveSpend(options: ReserveOptions): Promise<SpendReservation | null> {
  const { store, path, budgetUsd, costUsd, t, reservationTtlMs, expireAt } = options;
  const id = randomUUID();
  return store.update(path, (doc): StoreChange<SpendReservation | null> => {
    const spend = readSpend(doc);
    const holds = Object.fromEntries(
      Object.entries(spend.holds).filter(([, hold]) => hold.expireAt.getTime() > t),
    );
    const committed = spend.spentUsd + Object.values(holds).reduce((sum, hold) => sum + hold.usd, 0);
    if (committed >= budgetUsd || committed + costUsd > budgetUsd) return { result: null };
    holds[id] = { usd: costUsd, expireAt: new Date(t + reservationTtlMs) };
    return {
      doc: { spentUsd: spend.spentUsd, holds, ...(expireAt && { expireAt }) },
      result: reservation(options, id),
    };
  });
}

function reservation(
  { store, path, pricing, label }: ReserveOptions,
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
        await store.update(path, (doc) => {
          const spend = readSpend(doc);
          const hold = spend.holds[id];
          if (hold) hold.usd = Math.max(0, hold.usd - usd);
          return { doc: { ...doc, spentUsd: spend.spentUsd + usd, holds: spend.holds }, result: undefined };
        });
      } catch (error) {
        // Not rethrown: the visitor's answer is already streaming.
        unrecorded = true;
        console.error(`${label}: could not record $${usd} of usage`, error);
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
        console.error(`${label}: could not settle a reservation`, error);
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
