// Agent evals. What each command and flag does, and what --check fails on:
// docs/evals.md; why record/replay: docs/adr/0001-agent-evals-record-replay.md.
//
//   tsx scripts/eval.ts record [--only ot01,on02] [--provider name] [--paid] [--rerun] [--runs k]
//   tsx scripts/eval.ts rescore [--note "what the scoring change is"]
//   tsx scripts/eval.ts replay [--check]
//   tsx scripts/eval.ts check [--paid] [--issue]
//     Exits non-zero when a case ended in an error.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cases } from "../evals/cases";
import { createAnthropicModelClient } from "../src/anthropic";
import { caseName, recordingName, sameSet, setLabel, type SetId } from "../src/evals/format";
import {
  appendHistory,
  appendLiveRun,
  liveRunKind,
  parseHistory,
  type LiveRun,
} from "../src/evals/history";
import { withResults } from "../src/evals/doc-results";
import { liveCheck, liveCheckIssue, liveCheckTitle, renderLiveCheck } from "../src/evals/live-check";
import { liveRunConfig } from "../src/evals/live-run";
import { runScores } from "../src/evals/metrics";
import {
  evaluate,
  liveCase,
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
const evalsDocPath = fileURLToPath(new URL("../../docs/evals.md", import.meta.url));

const readHistory = () => readFile(historyPath, "utf8").catch(() => "");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: "boolean", default: false },
    issue: { type: "boolean", default: false },
    paid: { type: "boolean", default: false },
    rerun: { type: "boolean", default: false },
    only: { type: "string" },
    // k for pass@k: how many times a live run runs each case.
    runs: { type: "string", default: "3" },
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
  const name = `${recordingName(recording)}.json`;
  const tmp = join(dir, `.${name}.tmp`);
  await writeFile(tmp, `${JSON.stringify(recording, null, 2)}\n`);
  for (const old of await readdir(dir)) {
    if (old.startsWith(`${recording.caseId}-`) && old !== name) await rm(join(dir, old));
  }
  await rename(tmp, join(dir, name));
}

async function replay(check: boolean): Promise<number> {
  const history = parseHistory(await readHistory());
  const { report, summary, results, problems } = await evaluate({ cases, sets: await loadSets(), history });
  const committed = async (path: string) => readFile(path, "utf8").catch(() => undefined);
  const evalsDocText = await committed(evalsDocPath);
  if (evalsDocText === undefined) {
    console.error(`✗ ${evalsDocPath} is missing`);
    return 1;
  }
  const evalsDoc = withResults(evalsDocText, results);
  if (!check) {
    await writeFile(reportPath, report);
    await writeFile(summaryPath, summary);
    await writeFile(evalsDocPath, evalsDoc);
    console.log(`Wrote ${reportPath}, ${summaryPath} and the results in ${evalsDocPath}`);
    return problems.length ? 1 : 0;
  }
  problems.push(
    ...staleFiles(
      { report, summary, evalsDoc },
      { report: await committed(reportPath), summary: await committed(summaryPath), evalsDoc: evalsDocText },
    ),
  );
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (!problems.length) console.log("✓ Recordings are fresh, nothing leaks but the cases failing on purpose, report, summary and the evals doc's results are up to date");
  return problems.length ? 1 : 0;
}

/** The live settings, or `undefined` after printing why they can't be used. */
function paidConfig() {
  let config;
  try {
    // The agent's own config schema: the same settings, rejected the same way.
    config = liveRunConfig(process.env, { provider: values.provider });
  } catch (error) {
    console.error((error as Error).message);
    return undefined;
  }
  if (!config.local && !values.paid) {
    console.error(
      `${config.baseURL} is a paid provider. Only run against it with the owner's go-ahead, then pass --paid.`,
    );
    return undefined;
  }
  if (!config.apiKey) {
    console.error("ANTHROPIC_API_KEY is not set.");
    return undefined;
  }
  return { ...config, apiKey: config.apiKey };
}

async function record(): Promise<number> {
  const config = paidConfig();
  if (!config) return 1;
  const { baseURL, provider, model, effort, apiKey } = config;
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`--runs must be a whole number of at least 1, not "${values.runs}".`);
    return 1;
  }
  // Before any model call: a refused re-run costs nothing.
  const run = liveRun();
  const guard = liveRunKind(parseHistory(await readHistory()), { provider, model }, run.commit, values.rerun);
  if ("refused" in guard) {
    console.error(guard.refused);
    return 1;
  }
  const client = createAnthropicModelClient({ apiKey, model, effort, baseURL });
  const only = values.only?.split(",");
  const selected = cases.filter((c) => !only || only.includes(c.id));

  console.log(
    `Recording ${selected.length} cases × ${runs} runs with ${setLabel({ provider, model })} (effort ${effort}) at ${baseURL}`,
  );
  let failed = 0;
  for (const evalCase of selected) {
    const name = caseName(evalCase);
    try {
      const { recording, result } = await recordCase(evalCase, client, { provider, model }, { effort, runs });
      // Only now: a run that fails half-way never overwrites a good recording.
      await saveRecording(recording);
      const verdict = result.score.pass ? "pass" : `FAIL: ${result.score.reasons.join("; ")}`;
      const passed = runScores(result).filter((s) => s.pass).length;
      console.log(`  ${name}: ${verdict} (${result.latencyMs} ms; ${passed}/${runs} runs passed)`);
    } catch (error) {
      failed++;
      console.error(`  ${name}: not recorded: ${(error as Error).message}`);
    }
  }
  if (failed < selected.length) await appendToHistory({ provider, model }, run, guard.kind);
  const status = await replay(false);
  return failed ? 1 : status;
}

/**
 * The weekly live check (see `liveCheck`): one run per case, nothing written.
 * The log and the issue carry case names, scorer reasons and rates only, never
 * an answer.
 */
async function check(): Promise<number> {
  const config = paidConfig();
  if (!config) return 1;
  const { baseURL, provider, model, effort, apiKey } = config;
  const client = createAnthropicModelClient({ apiKey, model, effort, baseURL });
  console.log(`Live check: ${cases.length} cases × 1 run with ${setLabel({ provider, model })} (effort ${effort})`);
  const results = [];
  for (const evalCase of cases) {
    const result = await liveCase(evalCase, client);
    const verdict = result.response.error ? `error ${result.response.error}` : result.score.pass ? "pass" : "fail";
    console.log(`  ${caseName(evalCase)}: ${verdict}`);
    results.push(result);
  }
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
  const url = server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : undefined;
  const outcome = liveCheck({
    set: { provider, model },
    results,
    history: parseHistory(await readHistory()),
    run: { ...liveRun(), url },
  });
  console.log(`\n${renderLiveCheck(outcome)}`);
  if (values.issue) {
    const title = liveCheckTitle(outcome);
    const open = JSON.parse(
      gh(["issue", "list", "--state", "open", "--search", `in:title "${title}"`, "--json", "number,title"]),
    ) as { number: number; title: string }[];
    const issue = liveCheckIssue(outcome, open.find((i) => i.title === title)?.number);
    if (issue.action === "open") {
      gh(["issue", "create", "--title", issue.title, "--body-file", "-"], issue.body);
      console.log(`Opened the issue "${title}".`);
    } else if (issue.action === "comment") {
      gh(["issue", "comment", String(issue.issue), "--body-file", "-"], issue.body);
      console.log(`Commented on issue #${issue.issue}.`);
    } else {
      console.log("No issue: nothing to raise.");
    }
  }
  if (outcome.errored) {
    console.error(`${outcome.errored} cases ended in an error: the check is incomplete.`);
    return 1;
  }
  return 0;
}

/** Runs `gh` with `input` on stdin; its stdout. */
function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });
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
  check,
  rescore: rescoreRecordings,
  replay: () => replay(values.check),
} as const;
const mode = positionals[0];
if (mode !== "record" && mode !== "check" && mode !== "rescore" && mode !== "replay") {
  console.error(
    "Usage: eval.ts record [--only ids] [--paid] [--rerun] [--runs k] | check [--paid] [--issue] | rescore [--note text] | replay [--check]",
  );
  process.exit(2);
}
process.exitCode = await modes[mode]();
