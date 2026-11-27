// The sync manifest: where it lives and what it holds. The sync command
// (sync.mjs) writes it; the hooks read it.
//
// It is `<git common dir>/design-system-sync/<commit>.json`, for the commit's
// full sha, so every worktree of the clone finds the same file:
//
//   {
//     "format": 1,
//     "commit": "<full sha>",
//     "ref": "main@<short sha>",            // tokens.json meta.ref
//     "artifact": "https://claude.ai/artifact/<id>",
//     "root": "<dir holding project/>",
//     "files": [                             // every file of project/, sorted
//       { "path": "project/tokens.json", "file": "<absolute path>",
//         "contentType": "application/json", "sha256": "<64 hex>" }
//     ],
//     "publish": {                           // the Artifact call, as is
//       "url": "<artifact>", "root": "<root>",
//       "file_path": "<root>/project/design-system.json",
//       "files": { "project/tokens.json": { "from": "project/tokens.json", "contentType": "application/json" } }
//     }
//   }
//
// DS_SYNC_STORE names another folder for the store, so tests never write to
// the clone's real one.
import { readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { commonDir } from "./git.mjs";

/** The folder holding every sync manifest of the clone at `cwd`, from any of its worktrees. */
export function manifestStore(cwd = process.cwd()) {
  const store = process.env.DS_SYNC_STORE;
  return store ? resolve(store) : join(commonDir(cwd), "design-system-sync");
}

/** The manifest's path for `commit` (a full sha), from any worktree of the clone at `cwd`. */
export function manifestPath(commit, cwd = process.cwd()) {
  return join(manifestStore(cwd), `${commit}.json`);
}

/** The manifest for `commit`, or undefined when no sync wrote one. */
export function readManifest(commit, cwd = process.cwd()) {
  try {
    return JSON.parse(readFileSync(manifestPath(commit, cwd), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}

// The content type each file is published with. The types file goes as
// plain text, as the artifact serves it.
const types = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** The content type for a path under project/; throws on one it doesn't know. */
export function contentType(path) {
  if (path.endsWith(".d.ts")) return "text/plain";
  const type = types[extname(path)];
  if (!type) throw new Error(`no content type for ${path}: add its extension to manifest.mjs`);
  return type;
}
