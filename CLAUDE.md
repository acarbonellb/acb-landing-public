# acb-landing-public

Portfolio for albertocarbonell.dev. Next.js static export, React, TypeScript, Tailwind. Plan in GitHub Issues (spec: #2), content in `src/shared/profile.ts`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for acarbonellb/acb-landing-public (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Design System

The Design System artifact (https://claude.ai/artifact/9dpLiwikKeXPNuD9Cj4uUz) is derived from this repo, which stays the source of truth. Re-sync it with the `design-system-sync` skill after a merged change to the files it lists.

### Design canvases

A Design canvas on claude.ai is scratch space for one task, like a worktree: create one per issue, titled `#<issue> — <topic>`, link it from the issue, and build it from the Design System. Never reuse one across tasks or treat it as a source of truth. Delete it once the change is merged.

## Next.js rules

`AGENTS.md` is generated and kept up to date by `next dev`. Don't edit it; its rules are imported here:

@AGENTS.md
