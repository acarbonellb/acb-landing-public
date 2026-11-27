// The detection hooks: run the Design System sync when a merge touched its
// sources, so no sync depends on the agent remembering it. One script, three
// triggers (see .claude/settings.json):
//
// - PostToolUse on a Bash `gh pr merge`: fetches origin/main and the synced
//   marker, then checks.
// - PostToolUse on a Bash `git fetch` or `git pull`: checks the refs that
//   call brought, with no network of its own.
// - SessionStart: one fetch, then checks.
//
// A failed Bash call fires PostToolUseFailure, not PostToolUse, so a failed
// merge never reaches this script. When a sync is pending (pending.mjs), it
// runs the sync command (sync.mjs) and gives the agent one instruction:
// publish the manifest. When anything fails, it tells the user why and gives
// the agent nothing. Output is Claude Code's hook JSON on stdout:
// `additionalContext` for the agent, `systemMessage` for the user. It exits 0
// on every path, so no turn is blocked.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { TAG } from "./marker.mjs";
import { MAIN, pendingSync } from "./pending.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const FETCH_MS = 20_000;
// Longer than every step of sync.mjs together, shorter than the hook's timeout.
const SYNC_MS = Number(process.env.DS_DETECT_SYNC_TIMEOUT_MS) || 17 * 60_000;

let event = "PostToolUse";
function say({ user, agent }) {
  const out = {};
  if (user) out.systemMessage = user;
  if (agent) out.hookSpecificOutput = { hookEventName: event, additionalContext: agent };
  process.stdout.write(JSON.stringify(out) + "\n");
}

/** Each simple command of a shell line, as words. Good enough for the commands it looks for. */
function commands(line) {
  return String(line ?? "")
    .split(/&&|\|\||[;|&\n()]/)
    .map((c) => c.trim().split(/\s+/).filter(Boolean))
    .map((words) => {
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      return words;
    })
    .filter((w) => w.length);
}

// git options that take a separate value, skipped to find the subcommand.
const gitValueOptions = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
function gitSubcommand(words) {
  if (words[0] !== "git") return undefined;
  for (let i = 1; i < words.length; i++) {
    if (gitValueOptions.has(words[i])) i++;
    else if (!words[i].startsWith("-")) return words[i];
  }
  return undefined;
}

/** "merge", "fetch" or undefined for a Bash command line. */
function bashTrigger(line) {
  for (const words of commands(line)) {
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "merge") return "merge";
    const sub = gitSubcommand(words);
    if (sub === "fetch" || sub === "pull") return "fetch";
  }
  return undefined;
}

/** One fetch of origin's main and the synced marker. Returns the reason on failure. */
function fetch(cwd) {
  try {
    execFileSync(
      "git",
      ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/main:refs/remotes/${MAIN}`, `+refs/tags/${TAG}:refs/tags/${TAG}`],
      { cwd, encoding: "utf8", timeout: FETCH_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] },
    );
    return undefined;
  } catch (e) {
    if (e.code === "ETIMEDOUT" || e.signal === "SIGKILL") return `fetching origin timed out after ${FETCH_MS / 1000} s`;
    const err = String(e.stderr ?? "").trim();
    if (/couldn't find remote ref refs\/tags\//.test(err)) return `the ${TAG} tag is not on origin`;
    return `fetching origin failed: ${err.split("\n").filter(Boolean).pop() ?? e.message}`;
  }
}

/**
 * Where the sync writes the project folder: the session's scratchpad, which
 * the Artifact tool publishes from. Without one, the git common directory
 * when it is inside the working directory, else an ignored folder that is.
 */
function outDir(cwd, scratchpad, commit) {
  if (scratchpad) return join(scratchpad, "design-system-sync", commit);
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const inside = (dir) => {
    const r = relative(cwd, dir);
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  };
  if (inside(common)) return undefined;
  return join(cwd, "node_modules/.cache/design-system-sync", commit);
}

/** Runs the sync command for origin/main. Returns `{ manifest }` or `{ error }`. */
function runSync(cwd, out) {
  const args = [join(scripts, "sync.mjs"), "--ref", MAIN, ...(out ? ["--out", out] : [])];
  const r = spawnSync("node", args, { cwd, encoding: "utf8", timeout: SYNC_MS, killSignal: "SIGKILL" });
  if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL") return { error: `it timed out after ${SYNC_MS / 1000} s` };
  if (r.status !== 0) {
    const why = String(r.stderr ?? "").trim() || r.error?.message || `exit ${r.status}`;
    return { error: why.replace(/^design-system sync failed: /, "") };
  }
  const manifest = /^manifest: (.+)$/m.exec(r.stdout)?.[1];
  if (!manifest) return { error: "it printed no manifest path" };
  return { manifest };
}

function instruction(manifest, check) {
  const { artifact } = manifest;
  const short = manifest.commit.slice(0, 7);
  const listed = check.changed.length;
  return [
    `The Design System artifact is behind ${MAIN}: ${listed} listed source file(s) changed since ${TAG} (${check.marker.slice(0, 7)}).`,
    `This hook already ran the sync command for ${manifest.ref}; the sync manifest ${manifest.path} lists every file.`,
    "Publish it now, with these three Artifact calls and nothing else:",
    `1. Read ${artifact} with action "read" and no path.`,
    `2. Publish: one Artifact call whose arguments are the manifest's \`publish\` object, copied unchanged (url, root, file_path, files).`,
    `3. List ${artifact} with action "list" and scope "files". A hook verifies that listing against the manifest and moves ${TAG} to ${short}.`,
  ].join("\n");
}

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  event = input.hook_event_name ?? event;
  const cwd = input.cwd ?? process.cwd();
  let trigger;
  if (event === "SessionStart") trigger = "start";
  else if (event === "PostToolUse" && input.tool_name === "Bash" && !input.tool_response?.interrupted)
    trigger = bashTrigger(input.tool_input?.command);
  if (!trigger) process.exit(0);

  if (trigger !== "fetch") {
    const failed = fetch(cwd);
    if (failed) {
      say({ user: `Design System sync check skipped: ${failed}. The next trigger checks again.` });
      process.exit(0);
    }
  }
  const check = pendingSync(cwd);
  if (!check.pending) process.exit(0);
  const result = runSync(cwd, outDir(cwd, input.scratchpad_dir, check.main));
  if (result.error) {
    say({
      user:
        `Design System sync failed for ${MAIN} (${check.main.slice(0, 7)}): ${result.error}\n` +
        `The artifact stays behind; ${TAG} is unchanged, so the next trigger tries again.`,
    });
    process.exit(0);
  }
  const manifest = { ...JSON.parse(readFileSync(result.manifest, "utf8")), path: result.manifest };
  say({
    user: `Design System sync built ${manifest.ref}; the agent publishes it now.`,
    agent: instruction(manifest, check),
  });
} catch (e) {
  say({ user: `Design System sync check failed: ${e.message}. The next trigger checks again.` });
}
process.exit(0);
