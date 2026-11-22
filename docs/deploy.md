# CI and deployment

How a push reaches production, and why what runs there is what was tested: CI builds the site and the agent once, tests that build, and the deploy ships exactly it, the agent first, then the site, keeping the old agent revision until the new one passes a smoke check. The steps done once by hand are in [One-time setup](#one-time-setup).

`.github/workflows/deploy.yml` runs these jobs; a failing check blocks the deploy:

| Job | Runs on | What it does |
| --- | --- | --- |
| `test` | Every push and pull request | Lint, unit tests, the agent tests, the agent evals (replayed, see [Evals](evals.md#what-ci-gates)), build and browser tests |
| `rehearse-deploy` | Pull requests, and a manual dispatch on any branch but `main` (how the [ranges refresh](#ranges-refresh)'s PR gets its checks) | The deploy short of touching GCP |
| `deploy-agent` | `main`, once `GCP_PROJECT_ID` and `AGENT_URL` are set | [Agent deploy](#agent-deploy) |
| `deploy-site` | `main`, after `deploy-agent` succeeds, so the site never calls an agent that isn't live | [The site](#the-site), then its [smoke check](#smoke-check) |

Deploy jobs never cancel each other halfway (`cancel-in-progress: false`: a newer run waits).

## Deploy what was tested

The `test` job builds the site and the agent bundle once, with production settings (the site with `NEXT_PUBLIC_AGENT_URL` set to `AGENT_URL`), runs the browser tests against that build, hashes both (`scripts/artifact-hash.sh`: one sha256 over every file's path and bytes) and uploads them as the `site` and `agent-bundle` workflow artifacts. The browser tests never reach the production agent: `e2e/fixtures.ts` stubs its endpoints and refuses every request off the local server (ESLint makes every spec import `test` from there).

The deploy jobs download those artifacts and stop unless their hash matches the tested one; the agent image must hold the same bundle (`scripts/image-bundle-hash.sh`) and Cloud Run gets it by digest, and the deploy checks the live page is the tested `out/index.html` byte for byte. `rehearse-deploy` checks all of that short of touching GCP: artifacts round-trip and match, the image builds on the pinned base and holds the tested bundle, and the pinned firebase-tools installs.

## Pins

Actions are pinned by commit SHA (with the version in a comment), firebase-tools and all its dependencies by version and integrity (`deploy/firebase-tools/package-lock.json`, installed with `npm ci`), and the agent's base image by version and digest (`agent/Dockerfile`); `repo-hygiene/pipeline-pins.test.ts` fails if one of them floats. Bump a pin by changing the SHA and its comment, `npm install firebase-tools@<version> --package-lock-only` in `deploy/firebase-tools/`, or the image's tag and digest together.

## The site

`next build` produces a fully static site in `out/` (`output: "export"`), deployed to **Firebase Hosting**. GitHub authenticates to GCP with Workload Identity Federation, so there are no service account keys.

The site lives in the GCP project `acb-landing` (Firebase site `acb-landing`, default URL https://acb-landing.web.app) and is served on **https://albertocarbonell.dev**. `www.albertocarbonell.dev`, `albertocarbonell.es` and `www.albertocarbonell.es` are Hosting custom domains that redirect (301) to it; their DNS is in GoDaddy (an `A` record to `199.36.158.100` plus a `hosting-site=acb-landing` `TXT` on each apex, which must stay for Firebase to keep verifying ownership, and `www` as a `CNAME` to `acb-landing.web.app`).

The agent runs as a separate Cloud Run service that the browser calls directly at `AGENT_URL`, not through a Firebase Hosting rewrite, which buffers the stream and retries long requests ([ADR 0002](adr/0002-agent-direct-cloud-run-url.md)). Only `/mcp` goes through the rewrite (see [The agent URL](development.md#the-agent-url)).

### Security headers

Every page gets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a Content Security Policy (`frame-ancestors 'none'`, no plugins, `connect-src` limited to the site, the agent's origin and, in a build with a PostHog key, PostHog's two EU origins: [Site analytics](analytics.md#how-the-page-loads-it)). The browser tests serve every page with those headers and fail on any CSP violation.

A static export can't use nonces, so the CSP allows each inline script by its hash (the theme script and the RSC payloads Next writes, which change with every build, or the page doesn't hydrate). Those hashes only exist once the build has run, so `pnpm build` ends by writing `out/firebase.json` (`scripts/hosting-config.mts`): the committed `firebase.json` plus the CSP for that build, its `NEXT_PUBLIC_AGENT_URL` and its `NEXT_PUBLIC_POSTHOG_KEY`. The deploy ships that file (`firebase deploy --config out/firebase.json`). Edit headers and rewrites in the committed `firebase.json`, and the CSP in `src/lib/security-headers.ts`.

### Repository variables

The deploy jobs use these repository variables:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `acb-landing` |
| `GCP_WIF_PROVIDER` | `projects/864363287015/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA` | `github-deploy@acb-landing.iam.gserviceaccount.com` |
| `SITE_URL` | `https://albertocarbonell.dev`: URL the smoke check hits (defaults to `https://<GCP_PROJECT_ID>.web.app`) |
| `REDIRECT_HOSTS` | `www.albertocarbonell.dev albertocarbonell.es www.albertocarbonell.es`: hosts the smoke check expects to 301 to `SITE_URL` |
| `AGENT_URL` | The agent service's URL; also inlined into the site as `NEXT_PUBLIC_AGENT_URL`. Without it nothing deploys (the tested build then points at the local default, `http://localhost:8080`) |
| `POSTHOG_KEY` | Optional: the PostHog project key, inlined into the site as `NEXT_PUBLIC_POSTHOG_KEY`; public by design. Unset, the site has no [site analytics](analytics.md) |
| `AGENT_STORE` | Optional: unset deploys `firestore`, whose database must exist ([below](#the-firestore-database)). `memory` is refused in production (the service fails to start) |

The Workload Identity provider only accepts GitHub OIDC tokens from this repository (matched by repository and owner id, so a renamed or re-created repo can't reuse it) on `refs/heads/main`. The deploy service account `github-deploy` can only be impersonated through that provider and holds two roles: Firebase Hosting Admin, and Service Usage Viewer (firebase-tools checks the Hosting API is enabled before deploying). It has no keys.

### Smoke check

Once the live page matches the tested build, a **smoke check** (`scripts/smoke-check.sh`, runnable locally) fails the workflow unless `SITE_URL` answers 200 with a page containing "Alberto Carbonell" and the [security headers](#security-headers), and every host in `REDIRECT_HOSTS` answers 301 over http and https and ends on `SITE_URL`. Each check gets five attempts, 10 s apart.

## Agent deploy

The `deploy-agent` job takes the tested bundle, builds the image and deploys it by digest to Cloud Run:

| Setting | Value |
| --- | --- |
| Image | `agent/Dockerfile`: just the bundle on a pinned `node:24-slim`, pushed to Artifact Registry as `europe-southwest1-docker.pkg.dev/acb-landing/agent/agent:<sha>` |
| Service | Cloud Run `agent` in `europe-southwest1`: scale to zero, at most one instance, as the rate limits are in memory ([Guardrails](guardrails.md#rate-limits-are-per-instance)) |
| Runs as | `agent-runtime` |
| Secrets (Secret Manager, readable only by `agent-runtime`) | `ANTHROPIC_API_KEY` from `anthropic-api-key`, `CONTACT_EMAIL` from `contact-email`, `ANSWER_SIGNING_KEY` from `answer-signing-key` |
| `ALLOWED_ORIGINS` | `SITE_URL` |
| `AGENT_STORE` | The repository variable of the same name: `firestore` when unset, never `memory` ([Shared store](guardrails.md#shared-store)), with `FIRESTORE_PROJECT_ID` set to `GCP_PROJECT_ID` |
| Model and its prices | The code defaults ([configuration](agent.md#configuration)) |

The contact address never goes through GitHub variables or the workflow, as the repo and its Actions logs are public. The public (`allUsers`) invoker binding was set once by hand; deploys never change IAM, so `github-deploy` only has Cloud Run Developer, Service Account User on `agent-runtime` and Artifact Registry Writer on the `agent` repository.

The rollout keeps the serving revision until the new one has passed:

1. It records the revision serving 100% of traffic (a split stops the job before anything changes).
2. It deploys the new revision with `--no-traffic` under the tag `candidate`, which gives it its own URL.
3. `scripts/agent-smoke-check.sh --agent-only` runs against that tag URL. It never calls the model, so a deploy costs nothing. If it fails, the job stops and the previous revision keeps serving. It checks:
   - `/health`, then the deep check `/health?deep=1` ([health check](chat-contract.md#health-check)), which must answer 200, so a revision whose store read fails or that lacks a required secret never takes traffic;
   - that `/mcp` lists the five tools, and `get_contact` returns an email (without printing it);
   - that `/stats` answers the weekly JSON to any origin;
   - that `/chat` allows the site's origin (CORS preflight), rejects an invalid request with 400, and refuses an earlier answer without its signature (so the revision signs answers).
4. Traffic moves to the new revision, and the smoke check runs on `AGENT_URL` without `--agent-only`; if it fails, traffic goes back to the recorded revision. This run adds `/mcp` through the Hosting rewrite and leaves out the deep check, which already passed and whose rate limit anyone can use up on the public URL, so a flood can't roll a good deploy back (pinned by `scripts/agent-smoke-check.test.ts`).
5. The `candidate` tag is removed, pass or fail, so no extra public URL outlives the job.

Traffic stays pinned to a named revision after this, so a manual `gcloud run deploy` doesn't take traffic on its own: move it with `gcloud run services update-traffic agent --region europe-southwest1 --to-revisions <revision>=100` (or `--to-latest`).

### One-time setup

Done once, by the owner, by hand.

#### The answer signing key

Generate it locally without printing it, store it in Secret Manager and let only `agent-runtime` read it (what it signs: [Signed answers](chat-contract.md#signed-answers)):

```sh
openssl rand -base64 48 | tr -d '\n' |
  gcloud secrets create answer-signing-key --project acb-landing --replication-policy automatic --data-file=-
gcloud secrets add-iam-policy-binding answer-signing-key --project acb-landing \
  --member serviceAccount:agent-runtime@acb-landing.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
```

#### The Firestore database

The [shared store](guardrails.md#shared-store) (`PROJECT=acb-landing`):

```bash
gcloud services enable firestore.googleapis.com --project "$PROJECT"
gcloud firestore databases create --project "$PROJECT" --location europe-southwest1 --type firestore-native
# Read and write documents, nothing else: the minimum predefined role.
gcloud projects add-iam-policy-binding "$PROJECT" --role roles/datastore.user \
  --member "serviceAccount:agent-runtime@$PROJECT.iam.gserviceaccount.com"
# Deletes each key's daily quota document once its day is over.
gcloud firestore fields ttls update expireAt --collection-group dailySpend --enable-ttl --project "$PROJECT"
```

The database must exist before the agent's first deploy, or the new revision fails its deep health check. `roles/datastore.user` is project-wide (IAM conditions can't narrow it to collections); nothing else lives in this project's Firestore.

#### The weekly live eval check

The [weekly live check](evals.md#weekly-live-check) reads the Anthropic key from the secret `ANTHROPIC_API_KEY` of the GitHub environment `live-eval`, restricted to `main`, so a run from any other branch can't read it. Create it and copy the key from Secret Manager, piped so it is never printed or written to disk:

```bash
REPO=acarbonellb/acb-landing-public
gh api -X PUT "repos/$REPO/environments/live-eval" --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
gh api -X POST "repos/$REPO/environments/live-eval/deployment-branch-policies" -f name=main -f type=branch
gcloud secrets versions access latest --secret anthropic-api-key --project acb-landing |
  gh secret set ANTHROPIC_API_KEY --env live-eval --repo "$REPO"
```

Then dispatch it once from `main` (`gh workflow run live-eval.yml --ref main`) and check it ran green.

#### Rotating the Anthropic key

The key lives in Secret Manager (`anthropic-api-key`, the agent) and in the `live-eval` environment (the weekly check). Create the new key in the Claude Console, add it as a new version without printing it, copy it to the environment, then revoke the old key:

```bash
read -rs KEY # paste the key: not echoed
printf %s "$KEY" | gcloud secrets versions add anthropic-api-key --project acb-landing --data-file=-
unset KEY
gcloud secrets versions access latest --secret anthropic-api-key --project acb-landing |
  gh secret set ANTHROPIC_API_KEY --env live-eval --repo acarbonellb/acb-landing-public
```

The agent reads `anthropic-api-key:latest` when a revision starts, so redeploy (re-run the latest `main` deploy) before revoking the old key.

#### Alerts

The Cloud Monitoring alert policies: [Logs and alerts](logs-and-alerts.md#alerts-cloud-monitoring).

#### Billing budget

A monthly GCP billing budget warns the owner when the project's infrastructure bill (Cloud Run, Firestore and the rest) grows. It only alerts: it never stops a service or caps the bill. The model's spend is held by the [spend cap](guardrails.md#monthly-spend-cap) and the provider's own limit.

`scripts/billing-budget.sh` sets it up, with these values:

| Setting | Value |
| --- | --- |
| Amount | 5 EUR per calendar month, credits included |
| Scope | This project only (by project number) |
| Thresholds | 50%, 90% and 100% of actual spend, and 100% of forecast spend (the month is on track to cross the amount) |
| Who is notified | By email, the billing account's default recipients: everyone with Billing Account Administrator or Billing Account User on it. No Pub/Sub topic or Monitoring channel |

Run it from the owner's machine, whose `gcloud` login has a billing role on the account; the pipeline never runs it, so CI holds no billing or IAM permission:

```sh
scripts/billing-budget.sh --dry-run acb-landing  # reads only: prints what differs and the command it would run
scripts/billing-budget.sh acb-landing            # creates the budget, or reconciles the existing one in place
```

It finds the project's billing account and the one budget scoped to the project: a budget made by hand is adopted, never duplicated, and a re-run that matches changes nothing. Two budgets scoped to the project, or default recipients turned off, stop it without changes. It never prints the billing account id, so its output can go in a pull request. Change the values in the script and re-run it; `scripts/billing-budget.test.ts` runs it against a fake `gcloud`.

### `/mcp` rate-limit check

`scripts/mcp-rate-limit-check.sh`, by hand, never in CI, as it uses up your own `/mcp` window for a minute. Run it after a deploy that changes the rate limits, the client-IP rule or the Hosting rewrite, and paste its output (counts and status codes only) into the issue:

```bash
scripts/mcp-rate-limit-check.sh https://albertocarbonell.dev "$AGENT_URL" [per-ip-limit]
```

The limit defaults to `RATE_LIMIT_MCP_PER_MINUTE`, else the code default; pass it if the service is configured otherwise. After waking the service on `/health`, it runs three phases, each `ok` or `FAIL` (exit code 1 if any fails):

1. **Through the site**: MCP `tools/list` calls to the site's `/mcp` until one is refused with `429`, proving the rewrite's traffic is limited (per visitor, once phase 2 passes). Fewer allowed than the limit means part of the window was already used; a refusal in a window's last 10 s restarts it in the next window.
2. **Direct to the agent**: one call to `$AGENT_URL/mcp`, which must be refused: the same visitor gets the same key through the rewrite and directly ([Client IP](guardrails.md#client-ip)).
3. **Forged `X-Forwarded-For`**: five calls to each URL with made-up addresses (IPv4, IPv6 in a fresh `/64`, a two-entry chain), which must all be refused: forging the header doesn't buy a fresh window, because the key is the entry Cloud Run appends (measured live against the deployed service).

Against a bare local agent phase 3 fails, as no Cloud Run front end appends the real address; `agent/src/mcp-rate-limit-check.test.ts` runs the script against a local agent behind a stand-in front end.

## Ranges refresh

`.github/workflows/ranges-refresh.yml` runs every Monday (and on manual dispatch) `pnpm agent:ranges`, which downloads Google's three IP range lists ([Client IP](guardrails.md#client-ip)), validates each (the published shape, at least one prefix, no list down to under half its committed size) and rewrites `agent/src/google-ranges.json` only if a list's prefixes changed. Then it force-pushes a commit to the branch `ranges-refresh` and opens a PR from it to the branch the run started on, or updates the open one. A download that fails validation fails the run and opens no PR.

It uses only the default `GITHUB_TOKEN` (contents and pull-requests write, plus `actions: write`, as pushes and PRs made with that token start no workflows): it dispatches `deploy.yml` on the branch, and that run (`test` and `rehearse-deploy`) is the PR's checks. The repository setting "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General) must be on. The log and the PR carry counts and publication times only, never prefixes.
