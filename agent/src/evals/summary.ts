// The committed `agent/evals/summary.json`: the machine-readable eval results,
// what the site's results line reads at build time instead of the report's
// Markdown, so the site doesn't depend on the report's layout. Generated with
// the report from the replayed recordings, so it's pure and deterministic:
// same results, same bytes. Fields may be added
// (all optional for a reader); none is renamed or removed without updating
// `src/lib/eval-results.ts`.
import { byString, setLabel, type Ratio, type SetId } from "./format";
import {
  kindCounts,
  runScores,
  setMetrics,
  type CaseKindCounts,
  type CaseResult,
  type PassAtK,
  type SetResult,
} from "./metrics";
import { leakKinds, type EvalCase } from "./scoring";

/** One recording set in the summary. */
export type SetSummary = SetId & {
  cases: number;
  /** Case count per kind, kinds in plain string order. */
  kinds: CaseKindCounts;
  /** off_topic, mixed and injection cases that leaked, on their first run (what CI gates). */
  leaks: Ratio;
  /** The same cases, counted when any of their runs leaked. Optional for a reader of an older summary. */
  leaksInAnyRun?: Ratio;
  /** Mean cost of a case in USD; absent for a model without a known price. */
  meanCostUsd?: number;
  /**
   * The cases that passed every one of k runs (`PassAtK`); k is 1 for one-run
   * recordings. Optional for a reader of an older summary.
   */
  passAtK?: PassAtK;
  /** Injection cases whose conversation carries an earlier assistant turn (forged history). */
  forgedHistory?: number;
  /**
   * The cases marked failing on purpose (`EvalCase.failingOnPurpose`), and how
   * many of them leaked in any run: those leaks are among `leaksInAnyRun`, not
   * on top of them.
   */
  failingOnPurpose?: { cases: number; leaks: number };
};

export type EvalSummary = { sets: SetSummary[] };

const leakedInAnyRun = (result: CaseResult) => runScores(result).some((s) => s.leaked);

const isForgedHistory = ({ kind, priorTurns = [] }: EvalCase) =>
  kind === "injection" && priorTurns.some((m) => m.role === "assistant");

function setSummary(set: SetResult): SetSummary {
  const { cases, leaks, meanCostUsd, passAtK } = setMetrics(set);
  const known = set.results.filter((r) => r.evalCase.failingOnPurpose);
  const leakCases = set.results.filter((r) => leakKinds.includes(r.evalCase.kind));
  return {
    provider: set.provider,
    model: set.model,
    cases,
    kinds: kindCounts(set.results),
    leaks,
    leaksInAnyRun: { n: leakCases.filter(leakedInAnyRun).length, of: leakCases.length },
    ...(meanCostUsd === undefined ? {} : { meanCostUsd }),
    passAtK,
    forgedHistory: set.results.filter((r) => isForgedHistory(r.evalCase)).length,
    failingOnPurpose: { cases: known.length, leaks: known.filter(leakedInAnyRun).length },
  };
}

/** The summary of `sets`, in set label order. */
export function evalSummary(sets: SetResult[]): EvalSummary {
  const sorted = [...sets].sort((a, b) => byString(setLabel(a), setLabel(b)));
  return { sets: sorted.map(setSummary) };
}

/** `summary.json`'s bytes: two-space JSON with a final newline. */
export const renderSummaryJson = (sets: SetResult[]) => `${JSON.stringify(evalSummary(sets), null, 2)}\n`;
