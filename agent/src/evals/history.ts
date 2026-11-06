// The eval metrics history, `agent/evals/history.jsonl`: one line per recording
// set per live run or re-score, so it shows how prompt, model and scoring
// changes move the numbers. Live runs and re-scores append; replay only reads
// and checks it (the report renders it). Pure functions; the script does the
// file I/O.
import * as z from "zod";
import { makeLiveRun, sameSet, setLabel, type SetId } from "./format";
import { setMetrics, type Metrics, type SetResult } from "./metrics";
import { canonicalJson } from "./recording";
import { caseKinds } from "./scoring";

/** When and from where a live run was made. */
export type LiveRun = {
  /** UTC day of the live run, YYYY-MM-DD. */
  date: string;
  /** Short hash of the commit the live run started from. */
  commit: string;
};

/**
 * How an entry was made: a live run, a deliberate second live run at the same
 * commit (`--rerun`), the stored recordings scored again with no model call,
 * or the stored recordings rewritten to a new format by a script (#98), with
 * the same scores and no model call.
 */
export const entryKinds = ["live", "rerun", "rescored", "migrated"] as const;
export type EntryKind = (typeof entryKinds)[number];

export type HistoryEntry = LiveRun &
  SetId & {
    /** Absent from entries made before kinds were recorded (all live runs). */
    kind?: EntryKind;
    /**
     * The request identity (system prompt and tools) of the recordings it was
     * made from; absent from entries made before it covered the tools.
     */
    requestIdentity?: string;
    /** Those older entries' hash of the system prompt alone. */
    promptHash?: string;
    /** The set's recordings fingerprint; absent from entries made before it was recorded. */
    fingerprint?: string;
    /** A re-score's note on the scoring change it applies (ADR 0001, scorer changes). */
    note?: string;
    metrics: Metrics;
  };

const ratio = z.object({ n: z.number().int(), of: z.number().int() }).strict();

const entrySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    commit: z.string().min(1),
    kind: z.enum(entryKinds).optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    requestIdentity: z.string().min(1).optional(),
    promptHash: z.string().min(1).optional(),
    fingerprint: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
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
        // Absent from entries made before pass@k was recorded.
        passAtK: ratio.extend({ k: z.number().int().positive() }).strict().optional(),
        flaky: ratio.optional(),
        // Absent from entries made before case kinds were recorded.
        kinds: z.partialRecord(z.enum(caseKinds), z.number().int().nonnegative()).optional(),
      })
      .strict(),
  })
  .strict()
  .refine((e) => e.requestIdentity || e.promptHash, {
    message: "needs a requestIdentity (or, before it covered the tools, a promptHash)",
  }) satisfies z.ZodType<HistoryEntry>;

export function historyEntry(set: SetResult, run: LiveRun, kind: EntryKind): HistoryEntry {
  return {
    ...run,
    kind,
    provider: set.provider,
    model: set.model,
    requestIdentity: set.requestIdentity,
    fingerprint: set.fingerprint,
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
  kind: "live" | "rerun",
): string | undefined {
  if (!set || set.results.length !== caseCount) return undefined;
  return appendHistory(text, [historyEntry(set, run, kind)]);
}

/**
 * The re-run guard: what a live run of `set` at `commit` is. A second live run
 * at a commit that already has one (a live run or re-run; entries without a
 * kind were all live runs) is refused unless `rerun`, and is then marked as a
 * re-run, so the history never hides a lucky retry. Re-scores and migrations
 * don't count.
 */
export function liveRunKind(
  entries: HistoryEntry[],
  set: SetId,
  commit: string,
  rerun: boolean,
): { kind: "live" | "rerun" } | { refused: string } {
  const ranHere = entries.some(
    (e) => sameSet(e, set) && e.commit === commit && e.kind !== "rescored" && e.kind !== "migrated",
  );
  if (!ranHere) return { kind: "live" };
  if (rerun) return { kind: "rerun" };
  return {
    refused: `${setLabel(set)} already has a live run at commit ${commit}: commit a change first, or pass --rerun to record a re-run`,
  };
}

/** `text` with one JSON line per entry appended. */
export function appendHistory(text: string, entries: HistoryEntry[]): string {
  if (!entries.length) return text;
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return base + entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

/**
 * The metrics that differ between an entry and the set's current scores, by
 * value: a parsed entry's keys come back in the schema's order.
 */
function changedMetrics(entry: HistoryEntry, set: SetResult): string[] {
  const now = setMetrics(set);
  return Object.keys(now).filter(
    (k) =>
      canonicalJson(entry.metrics[k as keyof Metrics]) !== canonicalJson(now[k as keyof Metrics]),
  );
}

const rescore = "re-score with `pnpm agent:eval:rescore`";
const migrate =
  "migrate it with `pnpm --filter agent exec tsx scripts/migrate-request-identity.ts` (ADR 0001, #98)";

/**
 * What fails CI, for each recording set's latest history entry:
 * - missing, or its fingerprint or request identity differs from the recordings:
 *   recordings committed without the history line their live run appended, or
 *   a history line without its recordings. Only a live run fixes it.
 * - no fingerprint (made before fingerprints were recorded), or the same
 *   recordings now score differently (a scoring or case change): a re-score
 *   fixes it, with no model call.
 */
export function checkHistory(entries: HistoryEntry[], sets: SetResult[]): string[] {
  return sets.flatMap((set) => {
    const label = setLabel(set);
    const latest = entries.findLast((e) => sameSet(e, set));
    if (!latest) return [`${label} has no entry in agent/evals/history.jsonl: ${makeLiveRun}`];
    if (latest.fingerprint === undefined) {
      return [`${label}: latest history entry has no recordings fingerprint: ${rescore}`];
    }
    if (latest.requestIdentity === undefined) {
      return [`${label}: latest history entry has no request identity, only a system prompt hash: ${migrate}`];
    }
    const identity = [
      ...(latest.fingerprint !== set.fingerprint ? ["fingerprint"] : []),
      ...(latest.requestIdentity !== set.requestIdentity ? ["requestIdentity"] : []),
    ];
    if (identity.length) {
      return [`${label}: latest history entry doesn't match the recordings (${identity.join(", ")}): ${makeLiveRun}`];
    }
    const scores = changedMetrics(latest, set);
    return scores.length
      ? [`${label}: latest history entry was scored differently (${scores.join(", ")}): ${rescore}`]
      : [];
  });
}

/**
 * What `pnpm agent:eval:rescore` appends: a `rescored` entry for each set whose
 * stored recordings now score differently from its latest entry, or whose
 * latest entry has no fingerprint yet. Scores only change through a scoring or
 * case change, and that needs a `note` saying what it is (ADR 0001's rule for
 * scorer changes); with a note, every set gets an entry, since the change
 * applies to all of them, whether or not it moved their scores. Without one,
 * changed scores are refused. Never calls a model, so it only accepts
 * recordings the latest entry was made from: the same fingerprint and request
 * identity, or, for an entry from before fingerprints, the same metrics (with
 * recordings that still replay, what the history was checked by then).
 * Recordings that changed need a live run.
 */
export function rescoreHistory(
  entries: HistoryEntry[],
  sets: SetResult[],
  caseCount: number,
  run: LiveRun,
  note?: string,
): { entries: HistoryEntry[]; problems: string[] } {
  const appended: HistoryEntry[] = [];
  const problems: string[] = [];
  for (const set of sets) {
    const label = setLabel(set);
    const latest = entries.findLast((e) => sameSet(e, set));
    if (!latest) {
      problems.push(`${label} has no entry in agent/evals/history.jsonl: ${makeLiveRun}`);
      continue;
    }
    if (set.results.length !== caseCount) {
      problems.push(`${label}: some recordings are stale or missing, not re-scored: ${makeLiveRun}`);
      continue;
    }
    const legacy = latest.fingerprint === undefined;
    if (!legacy && latest.requestIdentity === undefined) {
      problems.push(`${label}: latest history entry has no request identity, not re-scored: ${migrate}`);
      continue;
    }
    const sameRecordings = legacy
      ? !changedMetrics(latest, set).length
      : latest.fingerprint === set.fingerprint && latest.requestIdentity === set.requestIdentity;
    if (!sameRecordings) {
      problems.push(`${label}: recordings changed since the latest history entry, not re-scored: ${makeLiveRun}`);
      continue;
    }
    if (note) {
      appended.push({ ...historyEntry(set, run, "rescored"), note });
    } else if (!legacy && changedMetrics(latest, set).length) {
      problems.push(
        `${label}: scores changed with the same recordings: say what the scoring change is with \`pnpm agent:eval:rescore --note "..."\``,
      );
    } else if (legacy) {
      appended.push(historyEntry(set, run, "rescored"));
    }
  }
  return { entries: appended, problems };
}
