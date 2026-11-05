// Formatting helpers for the content in `profile.ts`, shared by the page and
// the agent's tools. `formatPeriod`'s output is in tool results: changing it
// makes every eval recording stale, like editing a served value.
import type { Period } from "./profile";

/** "2019 — now", "2016 — 2019". */
export function formatPeriod({ from, to }: Period): string {
  return `${from} — ${to ?? "now"}`;
}
