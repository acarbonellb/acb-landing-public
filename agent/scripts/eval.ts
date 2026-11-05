// Agent evals (README, "Evals"; docs/adr/0001-agent-evals-record-replay.md).
//
//   tsx scripts/eval.ts record [--only ot01,on02] [--provider name] [--paid] [--rerun]
//     Live: runs every case against the configured model, records each one
//     that completes, appends the set's metrics to history.jsonl, then
//     regenerates the report and summary. Defaults to LM Studio on localhost; any other
//     server is a paid provider and needs --paid. Refused at a commit that
//     already has a live run of the set, unless --rerun (marked `rerun`).
//   tsx scripts/eval.ts rescore [--note "what the scoring change is"]
//     Scores the stored recordings with the current cases and scoring (no
//     model, no network), then regenerates the report and summary. With --note, appends a
//     `rescored` entry with the note for every set; without it, only adds
//     fingerprints to old entries and refuses scores that changed (ADR 0001).
//   tsx scripts/eval.ts replay [--check]
//     Replays the committed recordings (no model, no network) and writes the
//     report and summary.json; with --check, writes nothing and fails on stale
//     or missing recordings, leaks, a history that doesn't match the
//     recordings, or a report or summary that differs from the committed one.
//     Never appends history.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cases } from "../evals/cases";
import { createAnthropicModelClient } from "../src/anthropic";
import { caseName, sameSet, setLabel, type SetId } from "../src/evals/format";
import {
  appendHistory,
  appendLiveRun,
  liveRunKind,
  parseHistory,
  type LiveRun,
} from "../src/evals/history";
import {
  evaluate,
  recordCase,
  replaySets,
  rescore,
  staleFiles,
  type Recording,
  type RecordingSet,
} from "../src/evals/runner";

const evalsDir = fileURLToPath(new URL("../evals/", import.meta.url));
const recordingsDir = join(evalsDir, "recordings");
const reportPath = join(evalsDir, "report.md");
const summaryPath = join(evalsDir, "summary.json");
const historyPath = join(evalsDir, "history.jsonl");

const readHistory = () => readFile(historyPath, "utf8").catch(() => "");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: "boolean", default: false },
    paid: { type: "boolean", default: false },
    rerun: { type: "boolean", default: false },
    only: { type: "string" },
    provider: { type: "string" },
    note: { type: "string" },
  },
});

/** "qwen/qwen3.5-9b" → "qwen-qwen3.5-9b". */
function modelSlug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
}

async function loadSets(): Promise<RecordingSet[]> {
  const sets: RecordingSet[] = [];
  const dirs = async (path: string) =>
    (await readdir(path, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  for (const provider of await dirs(recordingsDir)) {
    for (const slug of await dirs(join(recordingsDir, provider))) {
      const dir = join(recordingsDir, provider, slug);
      const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
      const recordings = await Promise.all(
        files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as Recording),
      );
      if (recordings.length) {
        sets.push({ provider, model: recordings[0].model, recordings });
      }
    }
  }
  return sets;
}

/** Writes the recording, replacing any earlier file of the same case. */
async function saveRecording(recording: Recording) {
  const dir = join(recordingsDir, recording.provider, modelSlug(recording.model));
  await mkdir(dir, { recursive: true });
  const name = `${caseName({ id: recording.caseId, slug: recording.slug })}.json`;
  const tmp = join(dir, `.${name}.tmp`);
  await writeFile(tmp, `${JSON.stringify(recording, null, 2)}\n`);
  for (const old of await readdir(dir)) {
    if (old.startsWith(`${recording.caseId}-`) && old !== name) await rm(join(dir, old));
  }
  await rename(tmp, join(dir, name));
}

async function replay(check: boolean): Promise<number> {
  const history = parseHistory(await readHistory());
  const { report, summary, problems } = await evaluate({ cases, sets: await loadSets(), history });
  if (!check) {
    await writeFile(reportPath, report);
    await writeFile(summaryPath, summary);
    console.log(`Wrote ${reportPath} and ${summaryPath}`);
    return problems.length ? 1 : 0;
  }
  const committed = async (path: string) => readFile(path, "utf8").catch(() => undefined);
  problems.push(
    ...staleFiles(
      { report, summary },
      { report: await committed(reportPath), summary: await committed(summaryPath) },
    ),
  );
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (!problems.length) console.log("✓ Recordings are fresh, nothing leaks, report and summary are up to date");
  return problems.length ? 1 : 0;
}

function isLocal(url: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
}

async function record(): Promise<number> {
  const env = process.env;
  const baseURL = env.ANTHROPIC_BASE_URL || "http://localhost:1234";
  const local = isLocal(baseURL);
  if (!local && !values.paid) {
    console.error(
      `${baseURL} is a paid provider. Only record against it with the owner's go-ahead, then pass --paid.`,
    );
    return 1;
  }
  const provider =
    values.provider || env.AGENT_EVAL_PROVIDER || (local ? "lmstudio" : "anthropic");
  const model = env.AGENT_MODEL || "qwen/qwen3.5-9b";
  const apiKey = env.ANTHROPIC_API_KEY || (local ? "lmstudio" : "");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set.");
    return 1;
  }
  // Before any model call: a refused re-run costs nothing.
  const run = liveRun();
  const guard = liveRunKind(parseHistory(await readHistory()), { provider, model }, run.commit, values.rerun);
  if ("refused" in guard) {
    console.error(guard.refused);
    return 1;
  }
  const client = createAnthropicModelClient({ apiKey, model, effort: "low", baseURL });
  const only = values.only?.split(",");
  const selected = cases.filter((c) => !only || only.includes(c.id));

  console.log(`Recording ${selected.length} cases with ${setLabel({ provider, model })} at ${baseURL}`);
  let failed = 0;
  for (const evalCase of selected) {
    const name = caseName(evalCase);
    try {
      const { recording, result } = await recordCase(evalCase, client, { provider, model });
      // Only now: a run that fails half-way never overwrites a good recording.
      await saveRecording(recording);
      const verdict = result.score.pass ? "pass" : `FAIL: ${result.score.reasons.join("; ")}`;
      console.log(`  ${name}: ${verdict} (${result.latencyMs} ms)`);
    } catch (error) {
      failed++;
      console.error(`  ${name}: not recorded: ${(error as Error).message}`);
    }
  }
  if (failed < selected.length) await appendToHistory({ provider, model }, run, guard.kind);
  const status = await replay(false);
  return failed ? 1 : status;
}

/** Today (UTC) and the commit the run starts from. */
function liveRun(): LiveRun {
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  return { date: new Date().toISOString().slice(0, 10), commit };
}

/** Appends the history line of the set just recorded (see `appendLiveRun`). */
async function appendToHistory(id: SetId, run: LiveRun, kind: "live" | "rerun") {
  const { sets } = await replaySets({ cases, sets: await loadSets() });
  const set = sets.find((s) => sameSet(s, id));
  const text = appendLiveRun(await readHistory(), set, cases.length, run, kind);
  if (text === undefined) {
    console.error(`History not updated: some ${setLabel(id)} recordings are stale or missing.`);
    return;
  }
  await writeFile(historyPath, text);
  console.log(`Appended ${setLabel(id)} to ${historyPath}`);
}

/** Re-scores the stored recordings (see `rescore`): never calls a model. */
async function rescoreRecordings(): Promise<number> {
  const text = await readHistory();
  const { entries, problems } = await rescore({
    cases,
    sets: await loadSets(),
    history: parseHistory(text),
    run: liveRun(),
    note: values.note,
  });
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (entries.length) {
    await writeFile(historyPath, appendHistory(text, entries));
    for (const entry of entries) console.log(`Appended a re-scored ${setLabel(entry)} to ${historyPath}`);
  } else if (!problems.length) {
    console.log("Nothing to re-score: every set's latest entry matches its scores");
  }
  const status = await replay(false);
  return problems.length ? 1 : status;
}

const modes = {
  record,
  rescore: rescoreRecordings,
  replay: () => replay(values.check),
} as const;
const mode = positionals[0];
if (mode !== "record" && mode !== "rescore" && mode !== "replay") {
  console.error("Usage: eval.ts record [--only ids] [--paid] [--rerun] | rescore [--note text] | replay [--check]");
  process.exit(2);
}
process.exitCode = await modes[mode]();
