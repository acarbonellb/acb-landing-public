// PostToolUse hook on the Artifact tool: verifies a sync from the tool's real
// response, so "synced" never rests on the agent's word. It acts only on a
// `list` with `scope: "files"` for the Design System URL (sources.json
// `artifact`), and compares the listing with one sync manifest only: the one
// for the commit the local `origin/main` ref points at (manifest.mjs). No
// network until the marker moves.
//
// - every manifest entry listed with the same sha256, with no leftover under
//   `project/`: moves the synced marker (marker.mjs) to that commit and
//   pushes it;
// - otherwise it reports the paths that differ and, for leftovers, the exact
//   removal publish, and leaves the marker.
//
// A listing that matches a manifest of another commit (a branch's HEAD, an
// older main) is a mismatch: only origin/main's sync can move the marker.
// A response it can't parse is a failure, never a pass. Output is Claude
// Code's hook JSON on stdout (output.mjs). It exits 0 on every path, so no
// turn is blocked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAIN, shortSha, SKILL, skillDir } from "./git.mjs";
import { readManifest } from "./manifest.mjs";
import { moveMarker, TAG } from "./marker.mjs";
import { say as write } from "./output.mjs";
import { mainCommit } from "./pending.mjs";

const url = (u) => String(u ?? "").replace(/\/+$/, "");
const say = (user, agent = user) => write("PostToolUse", { user, agent });

/** How the listing differs from `manifest`: entries not listed with their sha256, and leftovers. */
function compare(manifest, listed) {
  const byPath = new Map(listed.map((f) => [f.path, f.sha256]));
  const wanted = new Set(manifest.files.map((f) => f.path));
  return {
    changed: manifest.files.filter((f) => byPath.get(f.path) !== f.sha256).map((f) => f.path),
    leftovers: listed.map((f) => f.path).filter((p) => p.startsWith("project/") && !wanted.has(p)),
  };
}

/**
 * The listed files from the tool's response, `[{ path, sha256 }]`. The shape
 * is internal to the Artifact tool, so anything unexpected throws.
 */
function listing(response, artifact) {
  const list = response?.file_list;
  if (!list || typeof list !== "object") throw new Error("the response has no file_list object");
  if (url(list.url) !== url(artifact)) throw new Error(`the listing is for ${JSON.stringify(list.url)}, not ${artifact}`);
  if (!Array.isArray(list.files)) throw new Error("file_list.files is not a list");
  return list.files.map((f, i) => {
    if (typeof f?.path !== "string" || !f.path) throw new Error(`file_list.files[${i}] has no path`);
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256))
      throw new Error(`${f.path} has no full sha256 in the listing`);
    return { path: f.path, sha256: f.sha256 };
  });
}

const unknown = (why) =>
  `${why}. Its format may have changed: update verify.mjs and its fixture, then list the files again.`;

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const cwd = input.cwd ?? process.cwd();
  const { artifact } = JSON.parse(readFileSync(join(skillDir, "sources.json"), "utf8"));
  const call = input.tool_input ?? {};
  const ours = input.tool_name === "Artifact" && call.action === "list" && call.scope === "files";
  if (!ours || url(call.url) !== url(artifact)) process.exit(0);
  let listed;
  try {
    listed = listing(input.tool_response, artifact);
  } catch (e) {
    throw new Error(unknown(`the Artifact listing has an unknown shape: ${e.message}`));
  }
  const main = mainCommit(cwd);
  const manifest = readManifest(main, cwd);
  if (!manifest)
    throw new Error(
      `no sync manifest for ${MAIN} (${shortSha(main)}) in this clone. Run \`node ${SKILL}/scripts/sync.mjs\`, publish its manifest, then list the files again`,
    );
  const { changed, leftovers } = compare(manifest, listed);
  if (!changed.length && !leftovers.length) {
    const short = shortSha(main);
    const moved = moveMarker(main, cwd);
    if (moved.ok) say(`Design System verified at ${manifest.ref}: ${TAG} moved to ${short} and pushed.`);
    else
      say(
        `Design System matches ${manifest.ref}, but ${moved.error}. The next trigger syncs it again.`,
        `Every file matches the sync manifest for ${manifest.ref}, but ${moved.error}. ` +
          `${TAG} was not moved. Tell the user; a later sync will verify and push it.`,
      );
  } else {
    const lines = [`The listing does not match the sync manifest for ${manifest.ref}; ${TAG} was not moved.`];
    if (changed.length) lines.push(`Not listed with the manifest's sha256 (${changed.length}):`, ...changed.map((p) => `- ${p}`));
    if (leftovers.length) {
      // The publish that removes them: the manifest's page, `null` per path.
      const removal = {
        url: manifest.publish.url,
        file_path: manifest.publish.file_path,
        files: Object.fromEntries(leftovers.map((p) => [p, null])),
      };
      lines.push(
        `Under project/ but not in the manifest (${leftovers.length}). Remove them with this Artifact publish, then list the files again:`,
        JSON.stringify(removal, null, 2),
      );
    }
    const parts = [
      changed.length && `${changed.length} file(s) differ`,
      leftovers.length && `${leftovers.length} leftover(s) to remove`,
    ].filter(Boolean);
    say(`Design System not verified against ${manifest.ref}: ${parts.join(", ")}.`, lines.join("\n"));
  }
} catch (e) {
  say(`Design System verification failed: ${e.message}`);
}
process.exit(0);
