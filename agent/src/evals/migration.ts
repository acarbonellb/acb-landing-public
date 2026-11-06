// The request-identity migration of the stored recordings and the eval history, run by
// `scripts/migrate-request-identity.ts`: recordings made before the request
// identity covered the tools held a system prompt hash and no settings. This
// rewrites them with the request identity and the model settings the code
// records now, and appends one `migrated` entry per set, so the history check
// (by fingerprint) keeps passing. No model is called.
//
// Only recordings their latest history entry was made from are migrated, and
// only while they still replay to the same scores: then the request identity
// is the current one by construction (their requests match the current system
// prompt and tools), and the settings are the ones every live run used until
// then (effort `low`, the adapter's parameters unchanged since the recordings
// were made).
import { makeLiveRun, sameSet, setLabel, type SetId } from "./format";
import { historyEntry, type HistoryEntry, type LiveRun } from "./history";
import { canonicalJson } from "./recording";
import {
  currentRequestIdentity,
  modelSettings,
  type ModelSettings,
  recordingsFingerprint,
  replaySets,
  type Recording,
  type RecordingSet,
  type RunOptions,
} from "./runner";
import type { EvalCase } from "./scoring";

/**
 * A recording file as stored, before or after the migration: the runs after
 * the first (`moreRuns`, pass@k) are kept as they are.
 */
export type StoredRecording = Omit<Recording, "requestIdentity" | "settings"> & {
  promptHash?: string;
  requestIdentity?: string;
  settings?: ModelSettings;
};


const isMigrated = (r: StoredRecording) =>
  r.requestIdentity !== undefined && r.settings !== undefined && r.promptHash === undefined;

/**
 * The migrated recording sets (only those that changed) and the history
 * entries to append; `problems` are sets left as they are.
 */
export async function migrateRequestIdentity({
  cases,
  sets,
  history,
  run,
  ...options
}: {
  cases: EvalCase[];
  sets: (SetId & { recordings: StoredRecording[] })[];
  history: HistoryEntry[];
  run: LiveRun;
} & RunOptions): Promise<{ sets: RecordingSet[]; entries: HistoryEntry[]; problems: string[] }> {
  const migrated: RecordingSet[] = [];
  const entries: HistoryEntry[] = [];
  const problems: string[] = [];
  const identity = currentRequestIdentity(options);
  for (const set of sets) {
    if (set.recordings.every(isMigrated)) continue;
    const label = setLabel(set);
    const latest = history.findLast((e) => sameSet(e, set));
    if (!latest || latest.fingerprint !== recordingsFingerprint(set.recordings)) {
      problems.push(`${label}: recordings don't match their latest history entry, not migrated: ${makeLiveRun}`);
      continue;
    }
    const recordings = set.recordings.map(
      ({ caseId, slug, provider, model, calls, moreRuns }): Recording => ({
        caseId,
        slug,
        provider,
        model,
        requestIdentity: identity,
        settings: modelSettings(model, options.effort ?? "low"),
        calls,
        ...(moreRuns ? { moreRuns } : {}),
      }),
    );
    const next: RecordingSet = { provider: set.provider, model: set.model, recordings };
    const replayed = await replaySets({ cases, sets: [next], ...options });
    const result = replayed.sets[0];
    const entry = historyEntry(result, run, "migrated");
    if (replayed.problems.length || result.results.length !== cases.length) {
      problems.push(
        `${label}: recordings don't replay with the current code, not migrated: ${makeLiveRun} (${replayed.problems.join("; ")})`,
      );
      continue;
    }
    if (canonicalJson(entry.metrics) !== canonicalJson(latest.metrics)) {
      problems.push(`${label}: recordings score differently from their latest history entry, not migrated: re-score first`);
      continue;
    }
    migrated.push(next);
    entries.push(entry);
  }
  return { sets: migrated, entries, problems };
}
