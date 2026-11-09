---
name: design-system-sync
description: Re-sync the site's Design System artifact on claude.ai from this repo. Use after a merged change to a file listed in sources.json (the edit hook names them), when adding or removing a component card, or to check whether the artifact is stale.
---

# Design System sync

The Design System artifact (its URL is `artifact` in [`sources.json`](sources.json)) is a **derived copy** of this repo: tokens, fonts, the site icon, and the site's real components compiled for React 19 with live previews and the real data. The repo is the source of truth; the artifact changes only by a re-sync from a commit on `main`.

`sources.json` lists every repo file the artifact is built from, by part: `tokens` (`globals.css`, `layout.tsx`), `assets`, `mirrored` (`page.tsx`, which `scripts/entry.tsx` copies by hand as `Page`), `content` (the copy and eval results the previews show: they change no design) and `bundle` (every other file the component bundle reads, written by the build).

## Steps

1. **Find what is stale.** Read `project/tokens.json` from the artifact (`Artifact` read with `path`) and take `meta.ref` (`main@<sha>`). Run `git diff --name-only <sha> origin/main` and match the files against `sources.json`. Done when you have the set of parts to redo, or none, in which case report the artifact current and stop. When only `content` changed, the artifact's design is current and only its copy lags: say so and sync only if the user wants it (any other sync carries the content along, since the build always reads the current files).
2. **Check out the commit you sync to**: `origin/main`, with `pnpm install --frozen-lockfile` if `node_modules` is missing. Done when `git status` is clean at that commit.
3. **Read before you write.** `read` the type's `SKILL.md` on the artifact URL (file shapes, the publish call, the index rules), then `read` `project/design-system.json` and every artifact file you will change. The read saves them under one folder in your scratchpad: that folder's `project/` is the `<project dir>` below.
4. **Redo each stale part**:
   - **tokens**: `node .claude/skills/design-system-sync/scripts/sync-tokens.mjs <project dir>` updates colour values in place. A colour it reports as added gets a usage note from the code that uses it; one reported as gone is removed only with the user's go-ahead. Type, spacing, radius and shadow changes from `layout.tsx` or `globals.css` go into `tokens.json` by hand, exact values.
   - **mirrored**: make `Page` in `scripts/entry.tsx` compose the page exactly as the new `src/app/page.tsx` does.
   - **bundle** (and after **tokens** or **mirrored**): `node .claude/skills/design-system-sync/scripts/build.mjs <project dir>`. If it fails because the bundle reads a file `sources.json` doesn't list, rerun with `--update-sources`; the changed `sources.json` goes in a PR.
   - **assets**: upload a changed icon as an asset and update its record in the index; copy a changed font file to `fonts/`.
   - **a component added or removed**: its entry in `components` in `scripts/entry.tsx`, its card in `scripts/previews.mjs`, its `README.md`, its props in `components/index.d.ts` and its source in `tokens.json` `meta.components`, all in step.
   Done when every stale part is rebuilt.
5. **Render check**: `node .claude/skills/design-system-sync/scripts/check.mjs <project dir> <shots dir> Page`, then look at `Page.<theme>.png` in both themes. Done when it prints that every preview renders and the page looks like the live site.
6. **Publish**: set `tokens.json` `meta.ref` to `main@<short sha>` and `meta.synced` to today, then publish only the changed files to the artifact URL in one call (`components/index.d.ts` with `contentType: "text/plain"`), with the index, read again right before, carrying a new `lastChange`. Done when the publish succeeds and `git status` shows nothing but the `sources.json`, `entry.tsx` or `previews.mjs` changes you meant.

## Reference

- **Colours live only in `tokens.json`.** `build.mjs` compiles `globals.css` without its two theme blocks, so the artifact's `tokens.css` supplies every colour and an edit on its page would win. Edits belong in the repo; a token changed on the page is overwritten by the next sync.
- **The scripts write only outside the repo**: `build.mjs` refuses a `<project dir>` inside it.
- **The bundle runs on the page's React.** `build.mjs` resolves `react` and `react/jsx-runtime` to `window.React`, with a ref-based `useEffectEvent` when the page's React lacks it, so the same `bundle.js` mounts on the artifact's React 19 and on a Design canvas, whose runtime provides React 18. Bundling React 19's own JSX runtime breaks the canvas (minified React error #31). A new React 19-only API in a component needs the same fallback there.
- **The agent is unreachable from the artifact.** `entry.tsx` gives the chat `agent.invalid` endpoints, so `Agent` and `Contact` render as on the site and a question sent from a preview fails. The MCP URL shown is the site's public one.
- **The edit hook** (`scripts/hook.mjs`, wired in `.claude/settings.json`) reminds once per session, on file-tool edits to listed paths outside `content`. Shell edits and changes made outside Claude Code reach the artifact only through step 1.
