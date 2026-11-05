// The eval metrics history, `agent/evals/history.jsonl`: one line per recording
// set per live run, so it shows how prompt and model changes move the numbers.
// Only live runs append; replay only reads and checks it (the report renders
// it). Pure functions; the script does the file I/O.
import * as z from "zod";
import { sameSet, setLabel, type SetId } from "./format";
import { setMetrics, type Metrics, type SetResult } from "./metrics";

/** When and from where a live run was made. */
export type LiveRun = {
  /** UTC day of the live run, YYYY-MM-DD. */
  date: string;
  /** Short hash of the commit the live run started from. */
  commit: string;
};

export type HistoryEntry = LiveRun &
  SetId & {
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
        leaks: ratio,
        toolAccuracy: ratio,
        factCoverage: ratio,
        unknownHandling: ratio,
        meanInputTokens: z.number(),
        meanOutputTokens: z.number(),
        meanLatencyMs: z.number(),
        // Absent from entries made before costs were recorded.
        meanCostUsd: z.number().optional(),
      })
      .strict(),
  })
  .strict();

export function historyEntry(set: SetResult, run: LiveRun): HistoryEntry {
  return {
    ...run,
    provider: set.provider,
    model: set.model,
    promptHash: set.promptHash,
    metrics: setMetrics(set),
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

/**
 * What a live run does to the history: one line for the set it recorded, with
 * the metrics of all its recordings. `undefined` (append nothing) while any of
 * the set's cases can't be replayed, so an entry always describes a complete
 * set. Replay never calls this.
 */
export function appendLiveRun(
  text: string,
  set: SetResult | undefined,
  caseCount: number,
  run: LiveRun,
): string | undefined {
  if (!set || set.results.length !== caseCount) return undefined;
  return appendHistory(text, [historyEntry(set, run)]);
}

/** `text` with one JSON line per entry appended. */
export function appendHistory(text: string, entries: HistoryEntry[]): string {
  if (!entries.length) return text;
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return base + entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

/**
 * What fails CI: a recording set whose latest history entry is missing or
 * doesn't match its recordings (prompt hash or any metric), i.e. recordings
 * committed without the history line their live run appended.
 */
export function checkHistory(entries: HistoryEntry[], sets: SetResult[]): string[] {
  const rerecord = "re-record with `pnpm agent:eval`";
  return sets.flatMap((set) => {
    const label = setLabel(set);
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
