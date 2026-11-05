// The committed `agent/evals/report.md`. Pure and deterministic: the same
// results and history always render the same bytes (no dates, no locale), so
// CI can compare the regenerated report with the committed one.
import { byString, caseName, percent, setLabel, type Ratio } from "./format";
import type { HistoryEntry } from "./history";
import {
  isFlaky,
  runScores,
  setMetrics,
  type CaseResult,
  type ModelSettings,
  type PassAtK,
  type SetResult,
} from "./metrics";
import { canonicalJson } from "./recording";
import { expectation, type CaseResponse } from "./scoring";

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

function actual({ answer, toolCalls, error }: CaseResponse): string {
  return [
    ...(toolCalls.length ? [toolCalls.join(", ")] : []),
    ...(error ? [`error: ${error}`] : []),
    excerpt(answer) || "(no answer)",
  ].join(" · ");
}

function settingsLine(settings: ModelSettings | undefined): string {
  if (!settings) return "Model settings: mixed (see `pnpm agent:eval:replay --check`)";
  return `Model settings: effort \`${settings.effort}\` · request parameters \`${canonicalJson(settings.requestParams)}\``;
}

/** The first run's verdict; with k runs, also how many of them passed. */
function verdict(result: CaseResult): string {
  const { score } = result;
  const first = score.pass ? "pass" : `FAIL: ${score.reasons.join("; ")}`;
  const runs = runScores(result);
  return runs.length > 1 ? `${first} · ${runs.filter((s) => s.pass).length}/${runs.length} runs` : first;
}

/** "pass@3 (every run passes)": the metric's name for its k. */
const passAtKName = ({ k }: PassAtK) => `pass@${k} (every run passes)`;

function flakyCell(set: SetResult, flaky: Ratio): string {
  const names = set.results
    .filter(isFlaky)
    .map((r) => caseName(r.evalCase))
    .sort(byString);
  return names.length ? `${flaky.n} (${names.join(", ")})` : String(flaky.n);
}

function renderSet(set: SetResult): string {
  const m = setMetrics(set);
  const passAtK = m.passAtK!;
  const rows = [...set.results]
    .sort((a, b) => byString(a.evalCase.id, b.evalCase.id))
    .map((result) =>
      [
        caseName(result.evalCase),
        result.evalCase.kind,
        expectation(result.evalCase),
        actual(result.response),
        verdict(result),
      ]
        .map(cell)
        .join(" | "),
    );
  return `## ${setLabel(set)}

${settingsLine(set.settings)}

Request identity (system prompt and tools) \`${set.requestIdentity.slice(0, 12)}\` · ${m.cases} cases

| Metric | Value |
| --- | --- |
| Off-topic leak rate | ${formatRatio(m.leaks)} |
| On-topic tool accuracy | ${formatRatio(m.toolAccuracy)} |
| Fact coverage | ${formatRatio(m.factCoverage)} |
| Unknown handling | ${formatRatio(m.unknownHandling)} |
| ${passAtKName(passAtK)} | ${formatRatio(passAtK)} |
| Flaky cases | ${flakyCell(set, m.flaky!)} |
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
      `pass@${m.passAtK!.k} ${formatRatio(m.passAtK!)}`,
      String(m.flaky!.n),
      String(m.meanInputTokens),
      String(m.meanOutputTokens),
      `${m.meanLatencyMs} ms`,
      formatUsd(m.meanCostUsd),
    ]
      .map(cell)
      .join(" | ");
  });
  return `## Summary

One row per recording set. Cost per case is the mean of each case's tokens at the model's list prices (the spend cap's too, in \`agent/src/pricing.ts\`); a local model costs $0. A live run records each case k times: pass@k is the share of cases that passed every one of their first k runs (k is the fewest runs any case has; 1 for one-run recordings), and Flaky counts the cases that passed some of their runs but not all. Every other metric is the first run's, the one CI replays.

| Model | Provider | Cases | Leak rate | Tool accuracy | Fact coverage | Unknown handling | pass@k | Flaky | Input tokens | Output tokens | Latency | Cost per case |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
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

/** History entries shown per recording set. */
const historyRows = 10;

/** "+5.6", "-42", "±0": the sign always shown, zero as ±0. */
function signed(delta: number, digits: number): string {
  const text = delta.toFixed(digits);
  if (Number(text) === 0) return `±${(0).toFixed(digits)}`;
  return delta > 0 ? `+${text}` : text;
}

function ratioCell(now: Ratio, before: Ratio | undefined): string {
  const value = percent(now);
  if (value === undefined) return "n/a";
  const previous = before && percent(before);
  const delta = previous === undefined ? "" : ` (${signed(value - previous, 1)} pp)`;
  return `${value.toFixed(1)}%${delta}`;
}

function countCell(now: number, before: number | undefined, unit = ""): string {
  const delta = before === undefined ? "" : ` (${signed(now - before, 0)})`;
  return `${now}${unit}${delta}`;
}

/** "pass@3 93.3% (+3.3 pp)": the change only against an entry of the same k. */
function passAtKCell(now: PassAtK | undefined, before: PassAtK | undefined): string {
  if (!now) return "n/a";
  return `pass@${now.k} ${ratioCell(now, before?.k === now.k ? before : undefined)}`;
}

/** The entry's request identity; an older entry's system prompt hash, marked as such. */
function identityCell({ requestIdentity, promptHash }: HistoryEntry): string {
  if (requestIdentity) return `\`${requestIdentity.slice(0, 12)}\``;
  return `\`${(promptHash ?? "").slice(0, 12)}\` (prompt only)`;
}

function historyRow(entry: HistoryEntry, previous: HistoryEntry | undefined): string {
  const m = entry.metrics;
  const p = previous?.metrics;
  return [
    entry.date,
    `\`${entry.commit}\``,
    // Entries from before kinds were recorded were all live runs.
    entry.kind ?? "live",
    identityCell(entry),
    String(m.cases),
    ratioCell(m.leaks, p?.leaks),
    ratioCell(m.toolAccuracy, p?.toolAccuracy),
    ratioCell(m.factCoverage, p?.factCoverage),
    ratioCell(m.unknownHandling, p?.unknownHandling),
    passAtKCell(m.passAtK, p?.passAtK),
    m.flaky ? countCell(m.flaky.n, p?.flaky?.n) : "n/a",
    countCell(m.meanInputTokens, p?.meanInputTokens),
    countCell(m.meanOutputTokens, p?.meanOutputTokens),
    countCell(m.meanLatencyMs, p?.meanLatencyMs, " ms"),
    formatUsd(m.meanCostUsd),
  ].join(" | ");
}

/** The report's "History" section; empty without history. Deterministic. */
export function renderHistory(entries: HistoryEntry[]): string {
  if (!entries.length) return "";
  const labels = [...new Set(entries.map(setLabel))].sort(byString);
  const sections = labels.map((label) => {
    const runs = entries.filter((e) => setLabel(e) === label);
    const rows = runs
      .map((entry, i) => historyRow(entry, runs[i - 1]))
      .slice(-historyRows)
      .reverse();
    const notes = runs
      .slice(-historyRows)
      .filter((e) => e.note)
      .reverse()
      .map((e) => `- ${e.date} \`${e.commit}\` ${e.kind ?? "live"}: ${e.note}`);
    return `### ${label}

| Date | Commit | Kind | Request identity | Cases | Leak rate | Tool accuracy | Fact coverage | Unknown handling | pass@k | Flaky | Input tokens | Output tokens | Latency | Cost per case |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r} |`).join("\n")}
${notes.length ? `\nNotes:\n\n${notes.join("\n")}\n` : ""}`;
  });
  return [
    `## History

Last ${historyRows} entries per recording set, newest first, from \`agent/evals/history.jsonl\`. Kind is \`live\` for a live run, \`rerun\` for a second live run at the same commit, \`rescored\` for the stored recordings scored again with no model call, with a note on the scoring change, and \`migrated\` for the stored recordings rewritten to a new format by a script, with the same scores and no model call. Request identity is a hash of the system prompt and the tools; older entries hold a hash of the system prompt alone, marked "prompt only". Changes are against the previous entry of the same set; pp is percentage points.
`,
    ...sections,
  ].join("\n");
}
