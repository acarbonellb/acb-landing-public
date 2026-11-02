# acb-landing-public

Personal portfolio for [albertocarbonell.dev](https://albertocarbonell.dev).

Next.js (App Router) + React + TypeScript + Tailwind CSS. Two colour schemes, Tokyo Night (default) and Tokyo Light, toggled from the header and saved in `localStorage`.

## Development

```bash
pnpm install
pnpm dev
```

Content lives in `src/content/profile.ts`.

## Deployment

`next build` produces a fully static site in `out/` (`output: "export"`), deployed to **Firebase Hosting** by `.github/workflows/deploy.yml` on every push to `main`. GitHub authenticates to GCP with Workload Identity Federation, so there are no service account keys.

The workflow is skipped until these repository variables exist:

| Variable | Example |
| --- | --- |
| `GCP_PROJECT_ID` | `acb-landing` |
| `GCP_WIF_PROVIDER` | `projects/123456789/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA` | `github-deploy@acb-landing.iam.gserviceaccount.com` |

The upcoming agent will run as a separate Cloud Run service, exposed under `/api/agent` through a Firebase Hosting rewrite.
