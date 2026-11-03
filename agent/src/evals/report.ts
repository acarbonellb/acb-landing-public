// Metrics and the committed `agent/evals/report.md`. Pure and deterministic:
// the same results always render the same bytes (no dates, no locale), so CI
// can compare the regenerated report with the committed one.
import type { Usage } from "../model";
import type { CaseOutcome, CaseScore, EvalCase } from "./scoring";

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
export type SetResult = {
  provider: string;
  model: string;
  /** SHA-256 of the system prompt the set was recorded with. */
  promptHash: string;
  results: CaseResult[];
};

/** `n` of `of` cases (or facts); `of: 0` means nothing measured it. */
export type Ratio = { n: number; of: number };

export type Metrics = {
  cases: number;
  /** off_topic, mixed and injection cases that leaked. */
  offTopicLeaks: Ratio;
  /** on_topic cases with expected tools that called one. */
  toolAccuracy: Ratio;
  /** Expected facts mentioned, over all mixed and on_topic cases. */
  factCoverage: Ratio;
  /** unknown cases that declined without inventing. */
  unknownHandling: Ratio;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanLatencyMs: number;
};

function ratio(scores: CaseScore[], hit: (s: CaseScore) => boolean): Ratio {
  return { n: scores.filter(hit).length, of: scores.length };
}

function mean(values: number[]): number {
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
}

export function computeMetrics(results: CaseResult[]): Metrics {
  const scores = (...kinds: EvalCase["kind"][]) =>
    results.filter((r) => kinds.includes(r.evalCase.kind)).map((r) => r.score);
  const withFacts = results.flatMap((r) => (r.score.facts ? [r.score.facts] : []));
  return {
    cases: results.length,
    offTopicLeaks: ratio(scores("off_topic", "mixed", "injection"), (s) => !!s.leaked),
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
  };
}

/** Plain string order, never locale order. */
export const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function formatRatio({ n, of }: Ratio): string {
  return of ? `${((n / of) * 100).toFixed(1)}% (${n}/${of})` : "n/a";
}

const maxExcerpt = 120;

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function excerpt(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length > maxExcerpt ? `${flat.slice(0, maxExcerpt - 1)}…` : flat;
}

function expected(c: EvalCase): string {
  switch (c.kind) {
    case "off_topic":
    case "injection":
      return "no leak";
    case "mixed":
      return `facts: ${c.facts.join(", ")}; no leak`;
    case "on_topic":
      return [
        c.tools.join(" or ") || "no tool",
        ...(c.facts.length ? [`facts: ${c.facts.join(", ")}`] : []),
        ...(c.mustMatch ? [`matches ${c.mustMatch}`] : []),
      ].join("; ");
    case "unknown":
      return "declines, invents nothing";
  }
}

function actual({ answer, toolCalls, error }: CaseOutcome): string {
  return [
    ...(toolCalls.length ? [toolCalls.join(", ")] : []),
    ...(error ? [`error: ${error}`] : []),
    excerpt(answer) || "(no answer)",
  ].join(" · ");
}

function renderSet(set: SetResult): string {
  const m = computeMetrics(set.results);
  const rows = [...set.results]
    .sort((a, b) => byString(a.evalCase.id, b.evalCase.id))
    .map(({ evalCase, outcome, score }) =>
      [
        `${evalCase.id}-${evalCase.slug}`,
        evalCase.kind,
        expected(evalCase),
        actual(outcome),
        score.pass ? "pass" : `FAIL: ${score.reasons.join("; ")}`,
      ]
        .map(cell)
        .join(" | "),
    );
  return `## ${set.provider} / ${set.model}

System prompt \`${set.promptHash.slice(0, 12)}\` · ${m.cases} cases

| Metric | Value |
| --- | --- |
| Off-topic leak rate | ${formatRatio(m.offTopicLeaks)} |
| On-topic tool accuracy | ${formatRatio(m.toolAccuracy)} |
| Fact coverage | ${formatRatio(m.factCoverage)} |
| Unknown handling | ${formatRatio(m.unknownHandling)} |
| Mean input tokens per case | ${m.meanInputTokens} |
| Mean output tokens per case | ${m.meanOutputTokens} |
| Mean latency per case | ${m.meanLatencyMs} ms |

| Case | Kind | Expected | Actual | Result |
| --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r} |`).join("\n")}
`;
}

export function renderReport(sets: SetResult[]): string {
  const sections = [...sets]
    .sort((a, b) => byString(`${a.provider}/${a.model}`, `${b.provider}/${b.model}`))
    .map(renderSet);
  return [
    `# Agent evals

Generated by \`pnpm agent:eval:replay\` from the recordings in \`agent/evals/recordings/\`. Don't edit it by hand: CI fails if it differs from the regenerated one.
`,
    ...sections,
  ].join("\n");
}
