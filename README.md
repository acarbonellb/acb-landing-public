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

The upcoming agent will run as a separate Cloud Run service, exposed under `/api/agent` through a Firebase Hosting rewrite.

## Roadmap

Planned work is tracked in [GitHub Issues](https://github.com/acarbonellb/acb-landing-public/issues).
