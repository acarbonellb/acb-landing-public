// PostToolUse hook on the Artifact tool: verifies a sync from the tool's real
// response, so "synced" never rests on the agent's word. It acts only on a
// `list` with `scope: "files"` for the Design System URL (sources.json
// `artifact`), and compares the listing with the sync manifests the sync
// command wrote (manifest.mjs):
//
// - a manifest whose every entry is listed with the same sha256, with no
//   leftover under `project/`: moves the synced marker (marker.mjs) to that
//   manifest's commit and pushes it;
// - otherwise it reports, against the newest manifest, the paths that differ
//   and, for leftovers, the exact removal publish, and leaves the marker.
//
// A response it can't parse is a failure, never a pass. Output is Claude
// Code's hook JSON on stdout: `additionalContext` for the agent,
// `systemMessage` for the user. It exits 0 on every path, so no turn is
// blocked.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestPath } from "./manifest.mjs";
import { moveMarker, TAG } from "./marker.mjs";

const skill = dirname(dirname(fileURLToPath(import.meta.url)));
const url = (u) => String(u ?? "").replace(/\/+$/, "");

function say(systemMessage, additionalContext = systemMessage) {
  process.stdout.write(
    JSON.stringify({ systemMessage, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }) + "\n",
  );
}

/** Every sync manifest of the clone at `cwd`, newest first. */
function manifests(cwd) {
  const store = dirname(manifestPath("x", cwd));
  let names;
  try {
    names = readdirSync(store).filter((n) => /^[0-9a-f]{40}\.json$/.test(n));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return names
    .map((n) => ({ file: join(store, n), mtime: statSync(join(store, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ file }) => JSON.parse(readFileSync(file, "utf8")));
}

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
  const { artifact } = JSON.parse(readFileSync(join(skill, "sources.json"), "utf8"));
  const call = input.tool_input ?? {};
  const ours = input.tool_name === "Artifact" && call.action === "list" && call.scope === "files";
  if (!ours || url(call.url) !== url(artifact)) process.exit(0);
  let listed;
  try {
    listed = listing(input.tool_response, artifact);
  } catch (e) {
    throw new Error(unknown(`the Artifact listing has an unknown shape: ${e.message}`));
  }
  const all = manifests(cwd);
  if (!all.length)
    throw new Error(
      "no sync manifest in this clone. Run `node .claude/skills/design-system-sync/scripts/sync.mjs`, publish its manifest, then list the files again",
    );
  const match = all.find((m) => {
    const { changed, leftovers } = compare(m, listed);
    return changed.length === 0 && leftovers.length === 0;
  });
  if (match) {
    const short = match.commit.slice(0, 7);
    const moved = moveMarker(match.commit, cwd);
    if (moved.ok) say(`Design System verified at ${match.ref}: ${TAG} moved to ${short} and pushed.`);
    else
      say(
        `Design System matches ${match.ref}, but ${moved.error}. The next trigger syncs it again.`,
        `Every file matches the sync manifest for ${match.ref}, but ${moved.error}. ` +
          `${TAG} was not moved. Tell the user; a later sync will verify and push it.`,
      );
  } else {
    const newest = all[0];
    const { changed, leftovers } = compare(newest, listed);
    const lines = [`The listing does not match the sync manifest for ${newest.ref}; ${TAG} was not moved.`];
    if (changed.length) lines.push(`Not listed with the manifest's sha256 (${changed.length}):`, ...changed.map((p) => `- ${p}`));
    if (leftovers.length) {
      // The publish that removes them: the manifest's page, `null` per path.
      const removal = {
        url: newest.publish.url,
        file_path: newest.publish.file_path,
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
    say(`Design System not verified against ${newest.ref}: ${parts.join(", ")}.`, lines.join("\n"));
  }
} catch (e) {
  say(`Design System verification failed: ${e.message}`);
}
process.exit(0);
