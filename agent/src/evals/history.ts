// The eval metrics history, `agent/evals/history.jsonl`: one line per recording
// set per live run, so it shows how prompt and model changes move the numbers.
// Only live runs append; replay only reads it. Pure functions; the script does
// the file I/O.
import * as z from "zod";
import { byString, computeMetrics, type Metrics, type Ratio, type SetResult } from "./report";

export type HistoryEntry = {
  /** UTC day of the live run, YYYY-MM-DD. */
  date: string;
  /** Short hash of the commit the live run started from. */
  commit: string;
  provider: string;
  model: string;
  promptHash: string;
  metrics: Metrics;
};

const ratio = z.object({ n: z.number().int(), of: z.number().int() }).strict();

const entrySchema: z.ZodType<HistoryEntry> = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    commit: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptHash: z.string().min(1),
    metrics: z
      .object({
        cases: z.number().int(),
        offTopicLeaks: ratio,
        toolAccuracy: ratio,
        factCoverage: ratio,
        unknownHandling: ratio,
        meanInputTokens: z.number(),
        meanOutputTokens: z.number(),
        meanLatencyMs: z.number(),
      })
      .strict(),
  })
  .strict();

export function historyEntry(
  set: SetResult,
  run: { date: string; commit: string },
): HistoryEntry {
  return {
    ...run,
    provider: set.provider,
    model: set.model,
    promptHash: set.promptHash,
    metrics: computeMetrics(set.results),
  };
}

export function parseHistory(text: string): HistoryEntry[] {
  return text.split("\n").flatMap((line, i) => {
    if (!line.trim()) return [];
    const where = `history.jsonl line ${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not JSON`);
    }
    const parsed = entrySchema.safeParse(json);
    if (!parsed.success) throw new Error(`${where}: ${z.prettifyError(parsed.error)}`);
    return [parsed.data];
  });
}

/** `text` with one JSON line per entry appended. */
export function appendHistory(text: string, entries: HistoryEntry[]): string {
  if (!entries.length) return text;
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return base + entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

const sameSet = (a: { provider: string; model: string }, b: typeof a) =>
  a.provider === b.provider && a.model === b.model;

/**
 * What fails CI: a recording set whose latest history entry is missing or
 * doesn't match its recordings (prompt hash or any metric), i.e. recordings
 * committed without the history line their live run appended.
 */
export function checkHistory(entries: HistoryEntry[], sets: SetResult[]): string[] {
  const rerecord = "re-record with `pnpm agent:eval`";
  return sets.flatMap((set) => {
    const label = `${set.provider}/${set.model}`;
    const latest = entries.findLast((e) => sameSet(e, set));
    if (!latest) return [`${label} has no entry in agent/evals/history.jsonl: ${rerecord}`];
    const now = historyEntry(set, latest);
    const fields = [
      ...(latest.promptHash !== now.promptHash ? ["promptHash"] : []),
      ...Object.keys(now.metrics).filter(
        (k) =>
          JSON.stringify(latest.metrics[k as keyof Metrics]) !==
          JSON.stringify(now.metrics[k as keyof Metrics]),
      ),
    ];
    return fields.length
      ? [`${label}: latest history entry doesn't match the recordings (${fields.join(", ")}): ${rerecord}`]
      : [];
  });
}

/** Live runs shown per recording set. */
export const historyRows = 10;

const percentOf = ({ n, of }: Ratio) => (of ? (n / of) * 100 : undefined);

/** "+5.6", "-42", "±0": the sign always shown, zero as ±0. */
function signed(delta: number, digits: number): string {
  const text = delta.toFixed(digits);
  if (Number(text) === 0) return `±${(0).toFixed(digits)}`;
  return delta > 0 ? `+${text}` : text;
}

function ratioCell(now: Ratio, before: Ratio | undefined): string {
  const value = percentOf(now);
  if (value === undefined) return "n/a";
  const previous = before && percentOf(before);
  const delta = previous === undefined ? "" : ` (${signed(value - previous, 1)} pp)`;
  return `${value.toFixed(1)}%${delta}`;
}

function countCell(now: number, before: number | undefined, unit = ""): string {
  const delta = before === undefined ? "" : ` (${signed(now - before, 0)})`;
  return `${now}${unit}${delta}`;
}

function row(entry: HistoryEntry, previous: HistoryEntry | undefined): string {
  const m = entry.metrics;
  const p = previous?.metrics;
  return [
    entry.date,
    `\`${entry.commit}\``,
    `\`${entry.promptHash.slice(0, 12)}\``,
    String(m.cases),
    ratioCell(m.offTopicLeaks, p?.offTopicLeaks),
    ratioCell(m.toolAccuracy, p?.toolAccuracy),
    ratioCell(m.factCoverage, p?.factCoverage),
    ratioCell(m.unknownHandling, p?.unknownHandling),
    countCell(m.meanInputTokens, p?.meanInputTokens),
    countCell(m.meanOutputTokens, p?.meanOutputTokens),
    countCell(m.meanLatencyMs, p?.meanLatencyMs, " ms"),
  ].join(" | ");
}

/** The report's "History" section; empty without history. Deterministic. */
export function renderHistory(entries: HistoryEntry[]): string {
  if (!entries.length) return "";
  const labels = [...new Set(entries.map((e) => `${e.provider} / ${e.model}`))].sort(byString);
  const sections = labels.map((label) => {
    const runs = entries.filter((e) => `${e.provider} / ${e.model}` === label);
    const rows = runs
      .map((entry, i) => row(entry, runs[i - 1]))
      .slice(-historyRows)
      .reverse();
    return `### ${label}

| Date | Commit | Prompt | Cases | Leak rate | Tool accuracy | Fact coverage | Unknown handling | Input tokens | Output tokens | Latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.map((r) => `| ${r} |`).join("\n")}
`;
  });
  return [
    `## History

Last ${historyRows} live runs per recording set, newest first, from \`agent/evals/history.jsonl\`. Changes are against the previous run of the same set; pp is percentage points.
`,
    ...sections,
  ].join("\n");
}
