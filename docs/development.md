# Development

```bash
pnpm install
pnpm dev
```

The site is Next.js (App Router), React, TypeScript and Tailwind CSS. It has two colour schemes, Tokyo Night (default) and Tokyo Light, toggled from the header and saved in `localStorage`.

## Content

Content lives in `src/shared/`: `profile.ts` is what the agent's tools serve (editing it makes the eval recordings stale, see [Evals](evals.md#when-to-make-a-live-run)), `site-copy.ts` is copy only the page shows, and `format.ts` holds the formatting helpers both use. The page's sections are listed once, in order, in `src/lib/sections.ts`.

## The agent URL

The "ask my agent" chat calls the [agent service](agent.md) straight from the browser. Its base URL is inlined at build time from `NEXT_PUBLIC_AGENT_URL`; the chat uses `<base>/chat`, for example `NEXT_PUBLIC_AGENT_URL=https://agent.example.run.app pnpm build`.

A production build shows `https://albertocarbonell.dev/mcp` as the public MCP endpoint: `firebase.json` rewrites `/mcp` on the site to the Cloud Run service `agent`. The chat can't go through that rewrite, because Hosting buffers streamed responses and retries long requests ([ADR 0002](adr/0002-agent-direct-cloud-run-url.md)); `next dev` shows `<base>/mcp`.

`next dev` defaults to `http://localhost:8080` (the local `pnpm agent:dev`). A production build without `NEXT_PUBLIC_AGENT_URL` shows an "agent coming soon" note instead of the chat, so the site never publishes a localhost endpoint.

## Tests

Tests check behaviour through accessible roles, text and the `data-theme` attribute, never CSS classes or markup structure. Both suites fake the agent with `src/testing/agent-fakes.ts`, typed against the shared contracts, so a contract change breaks the fakes at type-check (`pnpm build`). The contact fallback matrix is unit-tested; the browsers run its happy path and one fallback.

| Suite | Command | What it covers |
| --- | --- | --- |
| Unit | `pnpm test` (`pnpm test:watch` while developing) | Components with Vitest + React Testing Library. Files sit next to the code: `src/**/*.test.tsx`. Also the repo-tree checks in `repo-hygiene/` (no email address in any file, pinned pipeline, CI triggers, and every link in the README and `docs/` resolving) |
| Browser | `NEXT_PUBLIC_AGENT_URL=http://localhost:8080 pnpm build && pnpm test:e2e` | Playwright against the static export in `out/`, served locally on port 4173. Files live in `e2e/*.spec.ts`. The `agent` fixture (`e2e/fixtures.ts`) stubs the agent's chat, MCP and stats endpoints, so build with an agent URL (otherwise the page shows "agent coming soon"). The `page` fixture serves pages with the headers from `out/firebase.json` (see [Security headers](deploy.md#security-headers)) and fails a test on any CSP violation. Axe runs once, in `a11y.spec.ts`; overflow checks live in `layout.spec.ts`. |
| Agent | `pnpm agent:test` | The agent service, with a fake model: see [Agent service](agent.md#commands) |
| Evals | `pnpm agent:eval:replay --check` | The committed eval recordings, replayed: see [Evals](evals.md) |

Browser tests need Chromium and WebKit: run `pnpm exec playwright install chromium webkit` once, or point `CHROMIUM_PATH` at an existing Chromium binary (it only applies to the Chromium project). WebKit runs `e2e/mobile-menu.spec.ts`, `e2e/contact-mobile.spec.ts` and `e2e/layout.spec.ts` on an iPhone profile with a touch screen; it needs system libraries Chromium doesn't, so on a bare Linux or WSL install run `sudo pnpm exec playwright install-deps webkit` too. Linux WebKit doesn't share every iOS Safari quirk (it focuses a tapped link, for one), so check menu changes on a real iPhone as well.
