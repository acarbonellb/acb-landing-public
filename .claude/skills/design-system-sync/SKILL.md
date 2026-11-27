---
name: design-system-sync
description: Re-sync the site's Design System artifact on claude.ai from this repo. Use after a merged change to a file listed in sources.json (the edit hook names them), when adding or removing a component card, or to check whether the artifact is stale.
---

# Design System sync

The Design System artifact (its URL is `artifact` in [`sources.json`](sources.json)) is a **derived copy** of this repo: tokens, fonts, the site icon, and the site's real components compiled for React 19 with live previews and the real data. The repo is the source of truth; the artifact changes only by a re-sync from a commit on `main`.

`sources.json` lists every repo file the artifact is built from, by part: `tokens` (`globals.css`, `layout.tsx`), `assets`, `content` (the copy and eval results the previews show: they change no design), `bundle` (every other file the component bundle reads, written by the build; it includes `home-page.tsx`, the component `page.tsx` renders and the bundle exports as `Page`) and `skill` (this skill's scripts that shape the bundle, the cards, the types and the tokens, the token notes, and the hand-written copy in its `project/` folder).

The hand-written copy lives in this skill's [`project/`](project) folder, at the paths the artifact uses: every component's `components/<Name>/README.md`, the project `README.md`, `assets/*/README.md` and the cover card `components/Cover/preview.html`. Edit it there and review it in a pull request; the sync command writes it into the folder it publishes, so never edit it on the artifact.

## Manual sync

The sync command builds the artifact's whole `project/` folder from one commit and writes the **sync manifest**, the list of every file to publish. Nothing is edited by hand on the artifact.

1. **Run the command**: `node .claude/skills/design-system-sync/scripts/sync.mjs --out <scratchpad>/ds-sync` (add `--ref <rev>` for another commit than `origin/main`; `git fetch` first). It checks the commit out in a temporary worktree, installs with the frozen lockfile, runs that commit's `build.mjs` and removes the worktree. `--out` puts the folder where the Artifact tool can publish from; the manifest always goes to `<git common dir>/design-system-sync/<commit>.json`, and the command's last line names it. Done when it exits 0. On a failure it exits 1 with the reason: fix it in a pull request (for a file `sources.json` doesn't list, rerun `build.mjs` with `--update-sources` in your checkout and commit `sources.json`) and run it again once merged.
2. **Read the artifact**: `read` the manifest's `artifact` URL with no `path`. The publish is refused until that read has seen the live version, and a read by `path` doesn't count.
3. **Publish the manifest**: one Artifact publish with the manifest's `publish` object as is (`url`, `root`, `file_path` and `files`). It carries every file, `components/index.d.ts` as `text/plain` and the index (`design-system.json`) as the page.
4. **List the artifact's files**: `list` with `scope: "files"` on the artifact URL, as the last call of the sync. The verification hook (`scripts/verify.mjs`) reads that listing and compares every `sha256` with the manifest. On a full match it moves the synced marker, the `ds-synced` tag on GitHub, to the manifest's commit and pushes it; the sync is done only when it says so. Otherwise it names the paths that differ, or gives the exact publish that removes files under `project/` the manifest doesn't list (a component that was removed): publish what it names, then list again.

A component added or removed needs, in step and in one pull request: its entry in `components` in `scripts/entry.tsx`, its card in `scripts/previews.mjs` and its `project/components/<Name>/README.md` in this skill (listed in `sources.json` `skill`). The build writes its types and its source; `sync.test.ts` fails when one is missing or left over.

## Reference

- **Colours live only in `tokens.json`.** `build.mjs` compiles `globals.css` without its two theme blocks, so the artifact's `tokens.css` supplies every colour and an edit on its page would win. Edits belong in the repo (values in `globals.css`, notes in `token-notes.json`); a token changed on the page is overwritten by the next sync.
- **How `tokens.mjs` reads each token**: colours from the theme blocks, shadows from the `globals.css` rules that set `box-shadow` (named by class), `space-<n>` and `radius-<x>` from Tailwind's `p-<n>` and `rounded-<x>`, containers and type styles from the classes their note names, families from `@theme`'s `--font-<key>` through the next/font loader in `layout.tsx` (or the note's font file) followed by the note's fallback stack. A fluid size shows its largest value; `rounded-full` shows as `9999px`.
- **The scripts write only outside the repo**: `build.mjs` refuses a `<project dir>` inside it, and the sync command writes under the git common directory or `--out`.
- **The index** (`design-system.json`) is generated from [`index.json`](index.json): the libraries at the built React, `lastChange` from the commit. The site icon is an upload the index names by its blob; a changed `src/app/icon.svg` fails the sync until it is uploaded as an asset and its blob, size and sha256 are recorded in `index.json`.
- **The bundle runs on the page's React.** `build.mjs` resolves `react` and `react/jsx-runtime` to `window.React`, with a ref-based `useEffectEvent` when the page's React lacks it, so the same `bundle.js` mounts on the artifact's React 19 and on a Design canvas, whose runtime provides React 18. Bundling React 19's own JSX runtime breaks the canvas (minified React error #31). A new React 19-only API in a component needs the same fallback there.
- **The agent is unreachable from the artifact.** `entry.tsx` gives the chat `agent.invalid` endpoints, so `Agent` and `Contact` render as on the site and a question sent from a preview fails. The MCP URL shown is the site's public one.
- **The synced marker** (`ds-synced`, read and moved by `scripts/marker.mjs`) is a tag on origin, never a commit. Only the verification hook moves it, so a skipped or failed publish leaves it behind and the next sync retries. The artifact type's own files (`SKILL.md`, `index.html`, `artifact-type/`) are outside `project/` and never leftovers.
- **The edit hook** (`scripts/hook.mjs`, wired in `.claude/settings.json`) reminds once per session, on file-tool edits to listed paths outside `content`. Shell edits and changes made outside Claude Code reach the artifact only through a sync.
