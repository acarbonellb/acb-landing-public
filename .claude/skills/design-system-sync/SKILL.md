---
name: design-system-sync
description: Publish the Design System artifact on claude.ai. Use when a hook says the Design System is behind origin/main, or to run the same sync by hand after a failed one is fixed.
---

# Design System sync

The Design System artifact (`artifact` in [`sources.json`](sources.json)) is generated from `origin/main` by the sync command. Hooks in `.claude/settings.json` keep it current:

- `scripts/detect.mjs`, after a `gh pr merge`, a `git fetch` or `git pull`, and at session start. When a file of `sources.json` changed between the `ds-synced` tag and `origin/main`, it runs the sync command and gives you the instruction below.
- `scripts/verify.mjs`, after an Artifact `list` with `scope: "files"` on the artifact. It compares every sha256 with the sync manifest and, on a full match, moves `ds-synced` to the manifest's commit and pushes it.

The sync is done when `verify.mjs` reports `ds-synced moved to <commit> and pushed`. Only that hook moves the tag.

## When a hook gives the instruction

The instruction names the artifact URL and the sync manifest. Make its three Artifact calls in order, and no other Artifact call in between:

1. `read` the artifact URL with no `path`. The publish is refused until a read has seen the live version.
2. Publish with the manifest's `publish` object as the arguments, copied unchanged (`url`, `root`, `file_path`, `files`).
3. `list` the artifact URL with `scope: "files"`.

Then act on what `verify.mjs` reports:

- **Moved and pushed**: done.
- **Leftovers under `project/`**: make the removal publish it prints, unchanged, then `list` again.
- **Files that differ**, or a refused publish: run the manual sync below once. If they still differ, tell the user which paths.
- **Matched, but the tag push failed**: tell the user the reason it gives. The next trigger syncs again.
- **Unknown shape**: tell the user. The tool's response format changed, and `verify.mjs` and its fixture need an update in a pull request.

When `detect.mjs` reports a failed sync instead, it gives the user the reason and you nothing. Fix the cause in a pull request; once merged, the next trigger syncs.

## Manual sync

The same sync the hook runs, for after a fix or when the user asks. From any worktree of the clone:

1. Fetch what `detect.mjs` fetches:
   `git fetch --quiet --no-tags origin +refs/heads/main:refs/remotes/origin/main +refs/tags/ds-synced:refs/tags/ds-synced`
2. Run the sync command for `origin/main`, writing into your scratchpad:
   `node .claude/skills/design-system-sync/scripts/sync.mjs --ref origin/main --out <scratchpad>/design-system-sync/$(git rev-parse origin/main)`
   Done when it exits 0; its last line is `manifest: <path>`. On exit 1 it prints the reason: fix that in a pull request first.
3. Read the manifest at that path, then make the three Artifact calls and act on the report exactly as in [When a hook gives the instruction](#when-a-hook-gives-the-instruction).
