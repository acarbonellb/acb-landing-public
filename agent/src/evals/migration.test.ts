import { describe, expect, it } from "vitest";
import { createFakeModel } from "../fake-model";
import { evalContactEmail } from "./content";
import { historyEntry, liveRunKind, type HistoryEntry } from "./history";
import { migrateRequestIdentity, type StoredRecording } from "./migration";
import { evaluate, recordCase, recordingsFingerprint, type Recording } from "./runner";
import type { EvalCase } from "./scoring";

const contact: EvalCase = {
  id: "on01",
  slug: "contact",
  kind: "on_topic",
  question: "How can I contact him?",
  tools: ["get_contact"],
  facts: [evalContactEmail],
};

const meta = { provider: "fake", model: "scripted" };
const run = { date: "2026-11-06", commit: "e1f2a3b" };

/** A recording as stored before the request identity: a system prompt hash, no settings. */
function legacy(recording: Recording): StoredRecording {
  const { caseId, slug, provider, model, calls, moreRuns } = recording;
  return {
    caseId,
    slug,
    provider,
    model,
    promptHash: "8d9a".padEnd(64, "0"),
    calls,
    ...(moreRuns ? { moreRuns } : {}),
  };
}

/** A set of one legacy recording of `runs` runs, and the history entry it was fingerprinted by. */
async function legacySet(runs = 1) {
  const model = createFakeModel(
    Array.from({ length: runs }).flatMap(() => [
      { toolCalls: [{ id: "c1", name: "get_contact", input: {} }] },
      { text: `Email him at ${evalContactEmail}.` },
    ]),
  );
  const { recording } = await recordCase(contact, model, meta, { runs });
  const recordings = [legacy(recording)];
  const { sets } = await evaluate({ cases: [contact], sets: [{ ...meta, recordings: [recording] }] });
  const entry: HistoryEntry = {
    ...historyEntry(sets[0], { date: "2026-11-05", commit: "509c11f" }, "rescored"),
    requestIdentity: undefined,
    promptHash: recordings[0].promptHash,
    // What the entry's recordings fingerprint covered: the recordings as
    // stored then.
    fingerprint: recordingsFingerprint(recordings),
  };
  delete entry.requestIdentity;
  return { recording, recordings, history: [entry], model };
}

describe("migrateRequestIdentity (scripts/migrate-request-identity.ts)", () => {
  it("rewrites the recordings with their request identity and settings, and appends a migrated entry", async () => {
    const { recording, recordings, history, model } = await legacySet();
    const callsBefore = model.requests.length;

    const migrated = migrateRequestIdentity({ cases: [contact], sets: [{ ...meta, recordings }], history, run });
    const { entries, problems, sets } = await migrated;

    expect(problems).toEqual([]);
    expect(sets[0].recordings).toEqual([recording]);
    expect(entries).toEqual([
      {
        ...run,
        kind: "migrated",
        ...meta,
        requestIdentity: recording.requestIdentity,
        fingerprint: recordingsFingerprint([recording]),
        metrics: history[0].metrics,
      },
    ]);
    const after = await evaluate({ cases: [contact], sets, history: [...history, ...entries] });
    expect(after.problems).toEqual([]);
    expect(after.report).toContain("| migrated |");
    // No model call, and the migration is no live run for the re-run guard.
    expect(model.requests).toHaveLength(callsBefore);
    expect(liveRunKind([...history, ...entries], meta, run.commit, false)).toEqual({ kind: "live" });
  });

  it("keeps the runs after the first of a recording made with k runs", async () => {
    const { recording, recordings, history } = await legacySet(3);

    const { problems, sets, entries } = await migrateRequestIdentity({
      cases: [contact],
      sets: [{ ...meta, recordings }],
      history,
      run,
    });

    expect(problems).toEqual([]);
    expect(recording.moreRuns).toHaveLength(2);
    expect(sets[0].recordings).toEqual([recording]);
    expect(entries[0].metrics.passAtK).toEqual({ k: 3, n: 1, of: 1 });
  });

  it("does nothing to recordings already migrated", async () => {
    const { recordings, history } = await legacySet();
    const first = await migrateRequestIdentity({ cases: [contact], sets: [{ ...meta, recordings }], history, run });

    const again = await migrateRequestIdentity({
      cases: [contact],
      sets: first.sets,
      history: [...history, ...first.entries],
      run,
    });

    expect(again).toEqual({ sets: [], entries: [], problems: [] });
  });

  it("refuses recordings that don't match their latest history entry", async () => {
    const { recordings, history } = await legacySet();
    const edited = [{ ...recordings[0], calls: recordings[0].calls.map((c) => ({ ...c, latencyMs: 1 })) }];

    const result = await migrateRequestIdentity({ cases: [contact], sets: [{ ...meta, recordings: edited }], history, run });

    expect(result).toEqual({
      sets: [],
      entries: [],
      problems: [
        "fake / scripted: recordings don't match their latest history entry, not migrated: make a live run with `pnpm agent:eval`",
      ],
    });
  });

  it("refuses recordings that no longer replay", async () => {
    const { recordings, history } = await legacySet();

    const result = await migrateRequestIdentity({
      cases: [contact],
      sets: [{ ...meta, recordings }],
      history,
      run,
      system: "Another prompt.",
    });

    expect(result.entries).toEqual([]);
    expect(result.problems).toEqual([
      expect.stringMatching(/^fake \/ scripted: recordings don't replay with the current code, not migrated/),
    ]);
  });
});
