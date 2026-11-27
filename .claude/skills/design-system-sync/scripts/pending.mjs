// Whether a Design System sync is pending: `git diff` between the synced
// marker (`ds-synced`, marker.mjs) and `origin/main` lists a file of the
// sources list. Every part of the list counts, read from sources.json as it
// is at `origin/main`. Nothing else decides it. Local refs only, no network.
import { git, MAIN, shortSha, SKILL } from "./git.mjs";
import { readMarker, TAG } from "./marker.mjs";

const SOURCES = `${SKILL}/sources.json`;

/** The commit the local `origin/main` ref points at. No network; throws when the clone has none. */
export function mainCommit(cwd = process.cwd()) {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${MAIN}^{commit}`]);
  } catch {
    throw new Error(`${MAIN} is not in this clone`);
  }
}

/**
 * `{ pending, marker, main, changed }` for the clone at `cwd`: `changed` is
 * every listed file that differs between `ds-synced` and `origin/main`.
 * Throws with the reason when either ref or the sources list is missing.
 */
export function pendingSync(cwd = process.cwd()) {
  const marker = readMarker(cwd);
  if (!marker) throw new Error(`the ${TAG} tag is not in this clone, so no sync can be worked out`);
  const main = mainCommit(cwd);
  let sources;
  try {
    sources = JSON.parse(git(cwd, ["show", `${main}:${SOURCES}`]));
  } catch {
    throw new Error(`${MAIN} (${shortSha(main)}) has no readable ${SOURCES}`);
  }
  const listed = Object.values(sources)
    .filter(Array.isArray)
    .flat()
    .filter((p) => typeof p === "string" && p);
  const changed = listed.length
    ? git(cwd, ["diff", "--name-only", "--no-renames", marker, main, "--", ...listed])
        .split("\n")
        .filter(Boolean)
    : [];
  return { pending: changed.length > 0, marker, main, changed };
}
