// One-off migration (#98; ADR 0001): rewrites recordings stored with a system
// prompt hash and no settings into the current format (request identity of the
// system prompt and tools, plus the model settings), appends one `migrated`
// history entry per set it changed, then regenerates the report. No model, no
// network. Idempotent: migrated sets are left alone, so it's safe to re-run
// after merging a branch whose recordings or history predate it.
//
//   pnpm --filter agent exec tsx scripts/migrate-request-identity.ts
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "../evals/cases";
import { recordingName, setLabel } from "../src/evals/format";
import { appendHistory, parseHistory } from "../src/evals/history";
import { migrateRequestIdentity, type StoredRecording } from "../src/evals/migration";

const evalsDir = fileURLToPath(new URL("../evals/", import.meta.url));
const recordingsDir = join(evalsDir, "recordings");
const historyPath = join(evalsDir, "history.jsonl");

async function dirs(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

const sets: { provider: string; model: string; dir: string; recordings: StoredRecording[] }[] = [];
for (const provider of await dirs(recordingsDir)) {
  for (const slug of await dirs(join(recordingsDir, provider))) {
    const dir = join(recordingsDir, provider, slug);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    const recordings = await Promise.all(
      files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as StoredRecording),
    );
    if (recordings.length) sets.push({ provider, model: recordings[0].model, dir, recordings });
  }
}

const text = await readFile(historyPath, "utf8");
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const result = await migrateRequestIdentity({
  cases,
  sets,
  history: parseHistory(text),
  run: { date: new Date().toISOString().slice(0, 10), commit },
});

for (const problem of result.problems) console.error(`✗ ${problem}`);
for (const set of result.sets) {
  const { dir } = sets.find((s) => s.provider === set.provider && s.model === set.model)!;
  for (const recording of set.recordings) {
    const name = `${recordingName(recording)}.json`;
    await writeFile(join(dir, name), `${JSON.stringify(recording, null, 2)}\n`);
  }
  console.log(`Migrated ${set.recordings.length} ${setLabel(set)} recordings`);
}
if (result.entries.length) {
  await writeFile(historyPath, appendHistory(text, result.entries));
  for (const entry of result.entries) console.log(`Appended a migrated ${setLabel(entry)} to ${historyPath}`);
} else if (!result.problems.length) {
  console.log("Nothing to migrate");
}
// The report reads the migrated files: regenerate it as replay does.
execFileSync("pnpm", ["exec", "tsx", "scripts/eval.ts", "replay"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
});
process.exitCode = result.problems.length ? 1 : 0;
