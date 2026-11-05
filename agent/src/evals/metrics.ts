// A recording set's metrics and cost: what the report shows and the history
// stores. Pure; changes only when what is measured, or how it's priced, does.
import type { Usage } from "../model";
import { listPrices, usageCostUsd, type Pricing } from "../pricing";
import type { Ratio, SetId } from "./format";
import { leakKinds, type CaseResponse, type CaseScore, type EvalCase } from "./scoring";

/** One case replayed from its recording. */
export type CaseResult = {
  evalCase: EvalCase;
  response: CaseResponse;
  score: CaseScore;
  /** Summed over the case's model calls. */
  usage: Usage;
  latencyMs: number;
};

/** The results of one provider/model recording set. */
export type SetResult = SetId & {
  /** SHA-256 of the system prompt the set was recorded with. */
  promptHash: string;
  results: CaseResult[];
};

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
  };
}

function meanCost(results: CaseResult[], pricing: Pricing): number {
  if (!results.length) return 0;
  const microUsd = results.reduce((sum, r) => sum + usageCostUsd(r.usage, pricing) * 1e6, 0);
  return Math.round(microUsd / results.length) / 1e6;
}
