// The committed `agent/evals/summary.json`: the machine-readable eval results,
// what the site's results line reads at build time instead of the report's
// Markdown (#101). Generated with the report from the replayed recordings, so
// it's pure and deterministic: same results, same bytes. Fields may be added
// (all optional for a reader); none is renamed or removed without updating
// `src/lib/eval-results.ts`.
import { byString, setLabel, type Ratio, type SetId } from "./format";
import { setMetrics, type PassAtK, type SetResult } from "./metrics";
import type { EvalCase } from "./scoring";

/** One recording set in the summary. */
export type SetSummary = SetId & {
  cases: number;
  /** Case count per kind, kinds in plain string order. */
  kinds: Partial<Record<EvalCase["kind"], number>>;
  /** off_topic, mixed and injection cases that leaked. */
  leaks: Ratio;
  /** Mean cost of a case in USD; absent for a model without a known price. */
  meanCostUsd?: number;
  /**
   * The cases that passed every one of k runs (`PassAtK`); k is 1 for one-run
   * recordings. Optional for a reader of an older summary.
   */
  passAtK?: PassAtK;
};

export type EvalSummary = { sets: SetSummary[] };

function kindCounts(set: SetResult): SetSummary["kinds"] {
  const counts = new Map<EvalCase["kind"], number>();
  for (const { evalCase } of set.results) counts.set(evalCase.kind, (counts.get(evalCase.kind) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => byString(a, b)));
}

function setSummary(set: SetResult): SetSummary {
  const { cases, leaks, meanCostUsd, passAtK } = setMetrics(set);
  return {
    provider: set.provider,
    model: set.model,
    cases,
    kinds: kindCounts(set),
    leaks,
    ...(meanCostUsd === undefined ? {} : { meanCostUsd }),
    passAtK,
  };
}

/** The summary of `sets`, in set label order. */
export function evalSummary(sets: SetResult[]): EvalSummary {
  const sorted = [...sets].sort((a, b) => byString(setLabel(a), setLabel(b)));
  return { sets: sorted.map(setSummary) };
}

/** `summary.json`'s bytes: two-space JSON with a final newline. */
export const renderSummaryJson = (sets: SetResult[]) => `${JSON.stringify(evalSummary(sets), null, 2)}\n`;
