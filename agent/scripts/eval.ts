// Agent evals (README, "Evals"; docs/adr/0001-agent-evals-record-replay.md).
//
//   tsx scripts/eval.ts record [--only ot01,on02] [--provider name] [--paid]
//     Live: runs every case against the configured model, records each one
//     that completes, appends the set's metrics to history.jsonl, then
//     regenerates the report. Defaults to LM Studio on localhost; any other
//     server is a paid provider and needs --paid.
//   tsx scripts/eval.ts replay [--check]
//     Replays the committed recordings (no model, no network) and writes the
//     report; with --check, writes nothing and fails on stale or missing
//     recordings, leaks, a history that doesn't match the recordings, or a
//     report that differs from the committed one. Never appends history.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cases } from "../evals/cases";
import { createAnthropicModelClient } from "../src/anthropic";
import { caseName, sameSet, setLabel, type SetId } from "../src/evals/format";
import { appendLiveRun, parseHistory } from "../src/evals/history";
import { evaluate, recordCase, type Recording, type RecordingSet } from "../src/evals/runner";

const evalsDir = fileURLToPath(new URL("../evals/", import.meta.url));
const recordingsDir = join(evalsDir, "recordings");
const reportPath = join(evalsDir, "report.md");
const historyPath = join(evalsDir, "history.jsonl");

const readHistory = () => readFile(historyPath, "utf8").catch(() => "");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: "boolean", default: false },
    paid: { type: "boolean", default: false },
    only: { type: "string" },
    provider: { type: "string" },
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
  const { report, problems } = await evaluate({ cases, sets: await loadSets(), history });
  if (!check) {
    await writeFile(reportPath, report);
    console.log(`Wrote ${reportPath}`);
    return problems.length ? 1 : 0;
  }
  const committed = await readFile(reportPath, "utf8").catch(() => undefined);
  if (committed !== report) {
    problems.push(
      "agent/evals/report.md differs from the recordings: run `pnpm agent:eval:replay` and commit it",
    );
  }
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (!problems.length) console.log("✓ Recordings are fresh, nothing leaks, report is up to date");
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
  if (failed < selected.length) await appendToHistory({ provider, model });
  const status = await replay(false);
  return failed ? 1 : status;
}

/** Appends the history line of the set just recorded (see `appendLiveRun`). */
async function appendToHistory(id: SetId) {
  const { sets } = await evaluate({ cases, sets: await loadSets() });
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const date = new Date().toISOString().slice(0, 10);
  const set = sets.find((s) => sameSet(s, id));
  const text = appendLiveRun(await readHistory(), set, cases.length, { date, commit });
  if (text === undefined) {
    console.error(`History not updated: some ${setLabel(id)} recordings are stale or missing.`);
    return;
  }
  await writeFile(historyPath, text);
  console.log(`Appended ${setLabel(id)} to ${historyPath}`);
}

const mode = positionals[0];
if (mode !== "record" && mode !== "replay") {
  console.error("Usage: eval.ts record [--only ids] [--paid] | replay [--check]");
  process.exit(2);
}
process.exitCode = mode === "record" ? await record() : await replay(values.check);
