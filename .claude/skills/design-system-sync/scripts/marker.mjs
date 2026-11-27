// The synced marker: the git tag `ds-synced` on origin, at the last commit
// whose sync verified. It is force-moved and adds no commit. The
// verification hook (verify.mjs) moves it; the detection hooks read it to
// work out whether a sync is pending.
import { execFileSync } from "node:child_process";

export const TAG = "ds-synced";
const REF = `refs/tags/${TAG}`;

// Network steps get longer than local ones; neither may hang a hook.
const LOCAL_MS = 10_000;
const NETWORK_MS = 20_000;

function git(cwd, args, timeout = LOCAL_MS) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Why a git call failed, in one line. */
function reason(e) {
  if (e.code === "ETIMEDOUT" || e.signal === "SIGKILL") return "timed out";
  return String(e.stderr ?? "").trim().split("\n").filter(Boolean).pop() ?? e.message;
}

/** The commit the local `ds-synced` tag points at, or undefined when the clone has none. No network. */
export function readMarker(cwd = process.cwd()) {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${REF}^{commit}`]);
  } catch {
    return undefined;
  }
}

/**
 * Updates the local `ds-synced` tag from origin, even when it moved there
 * (a plain fetch keeps a tag it already has). Returns `{ ok, commit, error }`.
 */
export function fetchMarker(cwd = process.cwd()) {
  try {
    git(cwd, ["fetch", "--quiet", "--no-tags", "origin", `+${REF}:${REF}`], NETWORK_MS);
    return { ok: true, commit: readMarker(cwd) };
  } catch (e) {
    return { ok: false, commit: readMarker(cwd), error: reason(e) };
  }
}

/**
 * Force-moves `ds-synced` on origin to `commit` (a full sha), then the local
 * tag. The local tag moves only once the push succeeded, so it never claims a
 * sync origin doesn't record. Returns `{ ok, error }`.
 */
export function moveMarker(commit, cwd = process.cwd()) {
  try {
    git(cwd, ["push", "--quiet", "--force", "--no-verify", "origin", `${commit}:${REF}`], NETWORK_MS);
  } catch (e) {
    return { ok: false, error: `pushing ${TAG} failed: ${reason(e)}` };
  }
  try {
    git(cwd, ["tag", "--force", TAG, commit]);
  } catch (e) {
    return { ok: false, error: `${TAG} was pushed but the local tag did not move: ${reason(e)}` };
  }
  return { ok: true };
}
