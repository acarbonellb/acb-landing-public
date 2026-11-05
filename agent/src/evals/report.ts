// Metrics and the committed `agent/evals/report.md`. Pure and deterministic:
// the same results always render the same bytes (no dates, no locale), so CI
// can compare the regenerated report with the committed one.
import type { Usage } from "../model";
import { listPrices, usageCostUsd, type Pricing } from "../spend-cap";
import { byString, caseName, percent, setLabel, type Ratio, type SetId } from "./format";
import {
  expectation,
  leakKinds,
  type CaseOutcome,
  type CaseScore,
  type EvalCase,
} from "./scoring";

/** One case replayed from its recording. */
export type CaseResult = {
  evalCase: EvalCase;
  outcome: CaseOutcome;
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

/** "$0.000362"; "$0" for a free model; "n/a" without a price. */
export function formatUsd(usd: number | undefined): string {
  if (usd === undefined) return "n/a";
  return usd === 0 ? "$0" : `$${usd.toFixed(6)}`;
}

function formatRatio(r: Ratio): string {
  const value = percent(r);
  return value === undefined ? "n/a" : `${value.toFixed(1)}% (${r.n}/${r.of})`;
}

const maxExcerpt = 120;

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function excerpt(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length > maxExcerpt ? `${flat.slice(0, maxExcerpt - 1)}…` : flat;
}

function actual({ answer, toolCalls, error }: CaseOutcome): string {
  return [
    ...(toolCalls.length ? [toolCalls.join(", ")] : []),
    ...(error ? [`error: ${error}`] : []),
    excerpt(answer) || "(no answer)",
  ].join(" · ");
}

function renderSet(set: SetResult): string {
  const m = setMetrics(set);
  const rows = [...set.results]
    .sort((a, b) => byString(a.evalCase.id, b.evalCase.id))
    .map(({ evalCase, outcome, score }) =>
      [
        caseName(evalCase),
        evalCase.kind,
        expectation(evalCase),
        actual(outcome),
        score.pass ? "pass" : `FAIL: ${score.reasons.join("; ")}`,
      ]
        .map(cell)
        .join(" | "),
    );
  return `## ${setLabel(set)}

System prompt \`${set.promptHash.slice(0, 12)}\` · ${m.cases} cases

| Metric | Value |
| --- | --- |
| Off-topic leak rate | ${formatRatio(m.leaks)} |
| On-topic tool accuracy | ${formatRatio(m.toolAccuracy)} |
| Fact coverage | ${formatRatio(m.factCoverage)} |
| Unknown handling | ${formatRatio(m.unknownHandling)} |
| Mean input tokens per case | ${m.meanInputTokens} |
| Mean output tokens per case | ${m.meanOutputTokens} |
| Mean latency per case | ${m.meanLatencyMs} ms |
| Mean cost per case | ${formatUsd(m.meanCostUsd)} |

| Case | Kind | Expected | Actual | Result |
| --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r} |`).join("\n")}
`;
}

/** One row per set: model · provider · cases · quality · tokens · latency · cost. */
function renderSummary(sets: SetResult[]): string {
  const rows = sets.map((set) => {
    const m = setMetrics(set);
    return [
      set.model,
      set.provider,
      String(m.cases),
      formatRatio(m.leaks),
      formatRatio(m.toolAccuracy),
      formatRatio(m.factCoverage),
      formatRatio(m.unknownHandling),
      String(m.meanInputTokens),
      String(m.meanOutputTokens),
      `${m.meanLatencyMs} ms`,
      formatUsd(m.meanCostUsd),
    ]
      .map(cell)
      .join(" | ");
  });
  return `## Summary

One row per recording set. Cost per case is the mean of each case's tokens at the model's list prices (the spend cap's, in \`agent/src/spend-cap.ts\`); a local model costs $0.

| Model | Provider | Cases | Leak rate | Tool accuracy | Fact coverage | Unknown handling | Input tokens | Output tokens | Latency | Cost per case |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r} |`).join("\n")}
`;
}

export function renderReport(sets: SetResult[]): string {
  const sorted = [...sets].sort((a, b) => byString(setLabel(a), setLabel(b)));
  return [
    `# Agent evals

Generated by \`pnpm agent:eval:replay\` from the recordings in \`agent/evals/recordings/\`. Don't edit it by hand: CI fails if it differs from the regenerated one.
`,
    ...(sorted.length ? [renderSummary(sorted)] : []),
    ...sorted.map(renderSet),
  ].join("\n");
}
