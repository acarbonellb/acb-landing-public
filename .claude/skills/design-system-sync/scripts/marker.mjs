// The synced marker: the git tag `ds-synced` on origin, at the last commit
// whose sync verified. It is force-moved and adds no commit. The
// verification hook (verify.mjs) moves it; the detection hooks read it to
// work out whether a sync is pending.
import { git, MAIN, NETWORK_MS, reason, timedOut } from "./git.mjs";

export const TAG = "ds-synced";
const REF = `refs/tags/${TAG}`;

/** The commit the local `ds-synced` tag points at, or undefined when the clone has none. No network. */
export function readMarker(cwd = process.cwd()) {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${REF}^{commit}`]);
  } catch {
    return undefined;
  }
}

/**
 * One fetch of origin's main and the synced marker, into `origin/main` and
 * the local `ds-synced` tag, even when the tag moved on origin (a plain fetch
 * keeps a tag it already has). Returns `{ ok }`, or `{ ok: false, error }`
 * with the reason in a sentence.
 */
export function fetchMarker(cwd = process.cwd()) {
  try {
    git(cwd, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/main:refs/remotes/${MAIN}`, `+${REF}:${REF}`], NETWORK_MS);
    return { ok: true };
  } catch (e) {
    if (timedOut(e)) return { ok: false, error: `fetching origin timed out after ${NETWORK_MS / 1000} s` };
    if (/couldn't find remote ref refs\/tags\//.test(String(e.stderr ?? "")))
      return { ok: false, error: `the ${TAG} tag is not on origin` };
    return { ok: false, error: `fetching origin failed: ${reason(e)}` };
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
