# acb-landing-public

Personal portfolio for [albertocarbonell.dev](https://albertocarbonell.dev).

Next.js (App Router) + React + TypeScript + Tailwind CSS. Two colour schemes, Tokyo Night (default) and Tokyo Light, toggled from the header and saved in `localStorage`.

## Development

```bash
pnpm install
pnpm dev
```

Content lives in `src/content/profile.ts`.

## Tests

Tests check behaviour through accessible roles, text and the `data-theme` attribute, never CSS classes or markup structure.

| Suite | Command | What it covers |
| --- | --- | --- |
| Unit | `pnpm test` (`pnpm test:watch` while developing) | Components with Vitest + React Testing Library. Files sit next to the code: `src/**/*.test.tsx`. |
| Browser | `pnpm build && pnpm test:e2e` | Playwright against the static export in `out/`, served locally on port 4173. Files live in `e2e/*.spec.ts`. |

Browser tests need a Chromium: run `pnpm exec playwright install chromium` once, or point `CHROMIUM_PATH` at an existing Chromium binary.

## CI and deployment

`.github/workflows/deploy.yml` runs lint, unit tests, build and browser tests on every push and pull request. A failing check blocks the deploy.

`next build` produces a fully static site in `out/` (`output: "export"`), deployed to **Firebase Hosting** by the same workflow on every push to `main` once the checks pass. GitHub authenticates to GCP with Workload Identity Federation, so there are no service account keys.

The workflow is skipped until these repository variables exist:

| Variable | Example |
| --- | --- |
| `GCP_PROJECT_ID` | `acb-landing` |
| `GCP_WIF_PROVIDER` | `projects/123456789/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA` | `github-deploy@acb-landing.iam.gserviceaccount.com` |

The agent service (below) will run as a separate Cloud Run service, exposed under `/api/agent` through a Firebase Hosting rewrite.

## Agent service

`agent/` is a separate TypeScript service (pnpm workspace package) that answers questions about me. One set of read-only tools (`get_profile`, `get_experience`, `get_projects`, `get_stack`, `get_contact`) reads the same `src/content/profile.ts` as the landing, bundled in at build time, so the agent and the page never disagree.

The tools are served as an **MCP server over Streamable HTTP** (stateless, public, read-only), built with the official `@modelcontextprotocol/sdk` on [Hono](https://hono.dev).

```bash
pnpm agent:dev     # http://localhost:8080 (set PORT to change it), reloads on change
pnpm agent:test    # Vitest: tool unit tests + an MCP client against the HTTP service
pnpm agent:lint    # tsc + ESLint
pnpm agent:build   # self-contained bundle in agent/dist/main.js; run with `node agent/dist/main.js`
```

| Path | What |
| --- | --- |
| `POST /mcp` | MCP endpoint (Streamable HTTP) |
| `GET /health` | Health check, returns `{"status":"ok"}` |

Connect Claude Code to the local server:

```bash
claude mcp add --transport http albertocarbonell http://localhost:8080/mcp
```

Any other MCP client works the same way: point its Streamable HTTP transport at `/mcp`. To poke at it by hand, `npx @modelcontextprotocol/inspector` and connect to the same URL.

## Roadmap

Planned work is tracked in [GitHub Issues](https://github.com/acarbonellb/acb-landing-public/issues).
