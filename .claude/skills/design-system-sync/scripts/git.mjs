// What every script of the sync shares: running git (or another command)
// with a timeout, the names of the refs and folders they use, and how a
// commit is shown.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The branch the artifact is synced from, as a local remote-tracking ref. */
export const MAIN = "origin/main";
/** The skill folder, relative to the repo root (for `git show <commit>:<path>`). */
export const SKILL = ".claude/skills/design-system-sync";
/** The skill folder of this checkout, absolute. */
export const skillDir = dirname(dirname(fileURLToPath(import.meta.url)));

// Network steps get longer than local ones; neither may hang a hook.
export const LOCAL_MS = 10_000;
export const NETWORK_MS = 20_000;

/** The 7-character form of a commit, as `main@<short sha>` uses it. */
export const shortSha = (commit) => commit.slice(0, 7);

/** Whether a child process failed because its timeout killed it. */
export const timedOut = (e) => e?.code === "ETIMEDOUT" || e?.signal === "SIGKILL";

/** Runs `cmd`, killed after `timeout` ms; returns its trimmed stdout, throws on failure. */
export function run(cmd, args, { cwd, timeout = LOCAL_MS } = {}) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** Runs git in `cwd`; see `run`. */
export const git = (cwd, args, timeout = LOCAL_MS) => run("git", args, { cwd, timeout });

/** Why a git call failed, in one line. */
export function reason(e) {
  if (timedOut(e)) return "timed out";
  return String(e.stderr ?? "").trim().split("\n").filter(Boolean).pop() ?? e.message;
}

/** The clone's git common directory, shared by every worktree, absolute. */
export const commonDir = (cwd) => git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
