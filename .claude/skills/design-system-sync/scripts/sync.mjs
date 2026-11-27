// The sync command: builds the Design System artifact's whole `project/`
// folder from one commit and writes the sync manifest, the list of files to
// publish.
//
// Usage: node sync.mjs [--ref <rev>] [--out <dir>]
//        node sync.mjs --manifest-path [--ref <rev>]
//
// Run it from any worktree of the clone. It checks out <rev> (default
// `origin/main`) in a temporary worktree, installs dependencies there with the
// frozen lockfile, runs that commit's own build.mjs and removes the worktree,
// on success and on failure. So the output depends only on the commit, never
// on the branch or the files of the checkout it runs in.
//
// Writes, for the commit's full sha <commit>, under the git common directory
// (`git rev-parse --git-common-dir`, shared by every worktree):
//   design-system-sync/<commit>.json      the sync manifest (manifest.mjs)
//   design-system-sync/<commit>/project/  the folder it lists, unless --out
// --out <dir> writes the folder to <dir>/project instead (a session's
// scratchpad, which the Artifact tool can publish from); the manifest stays
// where it is. DS_SYNC_STORE moves the whole store (manifest.mjs), as the
// tests do. The last line of stdout is `manifest: <path>`.
//
// --manifest-path only prints where <rev>'s manifest is, building nothing.
//
// Every step has a timeout (DS_SYNC_<STEP>_TIMEOUT_MS overrides one, in ms).
// A failure exits 1 with the reason on stderr.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashes } from "./components.mjs";
import { MAIN, run, shortSha, SKILL, timedOut } from "./git.mjs";
import { contentType, manifestPath, manifestStore } from "./manifest.mjs";

const started = Date.now();
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--")) fail(`${name} needs a value`);
  return args[i + 1];
};

function fail(reason) {
  console.error(`design-system sync failed: ${reason}`);
  process.exit(1);
}

// A cold run (fresh worktree, install with an empty pnpm store) installs in
// about 20 s and builds in about 1 s; these leave room for a slow network.
// The detection hook caps the whole sync at 5 minutes.
const minutes = (n) => n * 60_000;
const timeouts = {
  git: minutes(1),
  install: minutes(3),
  build: minutes(2),
};
for (const step of Object.keys(timeouts)) {
  const env = process.env[`DS_SYNC_${step.toUpperCase()}_TIMEOUT_MS`];
  if (env) timeouts[step] = Number(env);
}

// Runs one step; a timeout or a non-zero exit becomes an error naming it.
function step(name, timeout, cmd, cmdArgs, cwd) {
  try {
    return run(cmd, cmdArgs, { cwd, timeout });
  } catch (e) {
    if (timedOut(e)) throw new Error(`${name} timed out after ${timeout} ms`);
    const detail = [e.stderr, e.stdout].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
    throw new Error(`${name} failed${detail ? `:\n${detail}` : ` (${e.message})`}`);
  }
}
const git = (...a) => step(`git ${a[0]}`, timeouts.git, "git", a, process.cwd());

const ref = option("--ref") ?? MAIN;
let commit;
try {
  commit = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
} catch {
  fail(`${ref} is not a commit in this clone`);
}
const manifestFile = manifestPath(commit, process.cwd());
if (args.includes("--manifest-path")) {
  console.log(manifestFile);
  process.exit(0);
}

// A commit from before the sync pipeline has an older build.mjs that writes
// only part of the folder. Refuse it rather than hand over a partial manifest.
const pipeline = ["scripts/sync.mjs", "scripts/manifest.mjs", "scripts/build.mjs", "sources.json"];
const missing = pipeline.filter((p) => {
  try {
    git("cat-file", "-e", `${commit}:${SKILL}/${p}`);
    return false;
  } catch {
    return true;
  }
});
if (missing.length)
  fail(
    `${ref} (${shortSha(commit)}) predates the sync pipeline: its ${SKILL} lacks ${missing.join(", ")}, ` +
      "so its build would give a partial folder. Nothing was built.",
  );

const store = manifestStore(process.cwd());
const outArg = option("--out");
const root = outArg ? resolve(outArg) : join(store, commit);
const temp = mkdtempSync(join(tmpdir(), "ds-sync-"));
const worktree = join(temp, "worktree");
let added = false;

// Removes the temporary worktree, whatever happened.
function cleanUp() {
  if (added) {
    try {
      run("git", ["worktree", "remove", "--force", worktree], { timeout: timeouts.git });
    } catch {
      // Removing the folder below and pruning drops the registration anyway.
    }
    added = false;
  }
  rmSync(temp, { recursive: true, force: true });
  try {
    run("git", ["worktree", "prune"], { timeout: timeouts.git });
  } catch {
    // Nothing left to do: the next prune drops it.
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cleanUp();
    fail(`stopped by ${signal}`);
  });
}

try {
  git("worktree", "add", "--detach", worktree, commit);
  added = true;
  console.log(`building ${ref} (${shortSha(commit)}) in a temporary worktree`);
  step("pnpm install", timeouts.install, "pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--filter", "."], worktree);

  // The commit's own build, into a folder of its own, moved into place once
  // it is complete, so a concurrent or failed run never leaves half a folder.
  const staging = join(temp, "project");
  const skill = join(worktree, SKILL);
  const built = step("build.mjs", timeouts.build, "node", [join(skill, "scripts/build.mjs"), staging], worktree);
  if (built) console.log(built);
  const { artifact } = JSON.parse(readFileSync(join(skill, "sources.json"), "utf8"));

  const project = join(root, "project");
  rmSync(project, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    renameSync(staging, project);
  } catch {
    cpSync(staging, project, { recursive: true });
  }

  const short = shortSha(commit);
  const files = Object.entries(hashes(project))
    .map(([path, sha256]) => ({
      path: `project/${path}`,
      file: join(project, path),
      contentType: contentType(path),
      sha256,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    format: 1,
    commit,
    ref: `main@${short}`,
    artifact,
    root,
    files,
    // The Artifact call that publishes it, as is.
    publish: {
      url: artifact,
      root,
      file_path: join(project, "design-system.json"),
      files: Object.fromEntries(files.map((f) => [f.path, { from: f.path, contentType: f.contentType }])),
    },
  };
  mkdirSync(store, { recursive: true });
  const partial = `${manifestFile}.${process.pid}`;
  writeFileSync(partial, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(partial, manifestFile);
  cleanUp();
  if (existsSync(worktree)) fail(`the temporary worktree ${worktree} is still there`);
  console.log(`${files.length} files in ${project} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  console.log(`manifest: ${manifestFile}`);
} catch (e) {
  cleanUp();
  fail(e.message);
}
