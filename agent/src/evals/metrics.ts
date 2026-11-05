// A recording set's metrics and cost: what the report shows and the history
// stores. Pure; changes only when what is measured, or how it's priced, does.
import type { Effort, Usage } from "../model";
import { listPrices, usageCostUsd, type Pricing } from "../pricing";
import type { Ratio, SetId } from "./format";
import { leakKinds, type CaseResponse, type CaseScore, type EvalCase } from "./scoring";

/**
 * One case replayed from its recording. Everything but `moreRuns` is its first
 * run: what CI gates on and the other metrics measure.
 */
export type CaseResult = {
  evalCase: EvalCase;
  response: CaseResponse;
  score: CaseScore;
  /** Summed over the first run's model calls. */
  usage: Usage;
  latencyMs: number;
  /** The scores of the runs after the first (pass@k); absent for a one-run recording. */
  moreRuns?: CaseScore[];
};

/** Every run's score, the first run's first. */
export const runScores = (r: CaseResult) => [r.score, ...(r.moreRuns ?? [])];

/** Each of the case's first `runs` runs (all of them by default) passed. */
const passes = (r: CaseResult, runs?: number) =>
  runScores(r)
    .slice(0, runs)
    .every((s) => s.pass);

/** The case passed some of its runs, not all of them. */
export const isFlaky = (r: CaseResult) => !passes(r) && runScores(r).some((s) => s.pass);

/** The model settings a recording was made with (`modelSettings` in the runner). */
export type ModelSettings = {
  effort: Effort;
  /** What the model client adds to every request, beyond the request itself. */
  requestParams: Record<string, unknown>;
};

/** The results of one provider/model recording set. */
export type SetResult = SetId & {
  /** The request identity the agent asks with now (system prompt and tools). */
  requestIdentity: string;
  /** Hash of the set's recordings (`recordingsFingerprint`). */
  fingerprint: string;
  /** The settings its recordings state; absent when they differ. */
  settings?: ModelSettings;
  results: CaseResult[];
};

/**
 * pass@k: the cases that passed every one of k runs. k is the fewest runs any
 * case of the set has, and every case counts its first k runs, so a set of
 * one-run recordings is pass@1.
 */
export type PassAtK = Ratio & { k: number };

export type Metrics = {
  cases: number;
  /** off_topic, mixed and injection cases that leaked ("off-topic leak rate"). */
  leaks: Ratio;
  /** on_topic cases with expected tools that called one. */
  toolAccuracy: Ratio;
  /** Expected facts mentioned, over all mixed and on_topic cases. */
  factCoverage: Ratio;
  /** unknown cases that declined without inventing. */
  unknownHandling: Ratio;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanLatencyMs: number;
  /**
   * Mean cost of a case in USD, rounded to the micro-dollar: its tokens at the
   * model's list prices. Absent for a model without a known price.
   */
  meanCostUsd?: number;
  /** Absent from entries made before pass@k was recorded. */
  passAtK?: PassAtK;
  /** Cases that passed some but not all of their runs; absent before pass@k. */
  flaky?: Ratio;
};

/** Providers that run the model locally, for free. */
const localProviders = new Set(["lmstudio"]);

const free: Pricing = { inputUsdPerMTok: 0, outputUsdPerMTok: 0 };

/** What the set's tokens cost: $0 locally, else the model's list prices (if known). */
export function setPricing({ provider, model }: SetId): Pricing | undefined {
  return localProviders.has(provider) ? free : listPrices[model];
}

function ratio(scores: CaseScore[], hit: (s: CaseScore) => boolean): Ratio {
  return { n: scores.filter(hit).length, of: scores.length };
}

function mean(values: number[]): number {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
}

/** The set's metrics, priced with `setPricing`. */
export const setMetrics = (set: SetResult) => computeMetrics(set.results, setPricing(set));

export function computeMetrics(results: CaseResult[], pricing: Pricing | undefined): Metrics {
  const scores = (...kinds: EvalCase["kind"][]) =>
    results.filter((r) => kinds.includes(r.evalCase.kind)).map((r) => r.score);
  const withFacts = results.flatMap((r) => (r.score.facts ? [r.score.facts] : []));
  return {
    cases: results.length,
    leaks: ratio(scores(...leakKinds), (s) => !!s.leaked),
    toolAccuracy: ratio(
      scores("on_topic").filter((s) => s.toolOk !== undefined),
      (s) => !!s.toolOk,
    ),
    factCoverage: {
      n: withFacts.reduce((sum, f) => sum + f.mentioned, 0),
      of: withFacts.reduce((sum, f) => sum + f.expected, 0),
    },
    unknownHandling: ratio(scores("unknown"), (s) => s.pass),
    meanInputTokens: mean(results.map((r) => r.usage.inputTokens)),
    meanOutputTokens: mean(results.map((r) => r.usage.outputTokens)),
    meanLatencyMs: mean(results.map((r) => r.latencyMs)),
    ...(pricing ? { meanCostUsd: meanCost(results, pricing) } : {}),
    passAtK: passAtK(results),
    flaky: { n: results.filter(isFlaky).length, of: results.length },
  };
}

function passAtK(results: CaseResult[]): PassAtK {
  const k = results.length ? Math.min(...results.map((r) => runScores(r).length)) : 1;
  return { k, n: results.filter((r) => passes(r, k)).length, of: results.length };
}

function meanCost(results: CaseResult[], pricing: Pricing): number {
  if (!results.length) return 0;
  const microUsd = results.reduce((sum, r) => sum + usageCostUsd(r.usage, pricing) * 1e6, 0);
  return Math.round(microUsd / results.length) / 1e6;
}
