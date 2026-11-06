# CI and deployment

`.github/workflows/deploy.yml` runs lint, unit tests, the agent tests, the agent evals (replayed, see [Evals](evals.md#what-ci-gates)), build and browser tests on every push and pull request. A failing check blocks the deploy.

## Deploy what was tested

The `test` job builds the site and the agent bundle once, with production settings (the site with `NEXT_PUBLIC_AGENT_URL` set to `AGENT_URL`), runs the browser tests against that build, hashes both (`scripts/artifact-hash.sh`: one sha256 over every file's path and bytes) and uploads them as the `site` and `agent-bundle` workflow artifacts. The browser tests never reach the production agent: `e2e/fixtures.ts` stubs its endpoints and refuses every request off the local server (ESLint makes every spec import `test` from there). The deploy jobs download those artifacts and stop unless their hash matches the tested one; the agent image must hold the same bundle (`scripts/image-bundle-hash.sh`) and Cloud Run gets it by digest, and the deploy checks the live page is the tested `out/index.html` byte for byte.

On a pull request (and on a manual dispatch on any branch but `main`, which is how the ranges refresh's PR gets its checks), `rehearse-deploy` does all of that short of touching GCP: artifacts round-trip and match, the image builds on the pinned base and holds the tested bundle, and the pinned firebase-tools installs.

Order on `main`: `deploy-agent`, then `deploy-site`, so the site never calls an agent that isn't live. Deploy jobs never cancel each other halfway (`cancel-in-progress: false`: a newer run waits).

## Pins

Actions are pinned by commit SHA (with the version in a comment), firebase-tools and all its dependencies by version and integrity (`deploy/firebase-tools/package-lock.json`, installed with `npm ci`), and the agent's base image by version and digest (`agent/Dockerfile`); `repo-hygiene/pipeline-pins.test.ts` fails if one of them floats. Bump a pin by changing the SHA and its comment, `npm install firebase-tools@<version> --package-lock-only` in `deploy/firebase-tools/`, or the image's tag and digest together.

## The site

`next build` produces a fully static site in `out/` (`output: "export"`), deployed to **Firebase Hosting**. GitHub authenticates to GCP with Workload Identity Federation, so there are no service account keys.

The site lives in the GCP project `acb-landing` (Firebase site `acb-landing`, default URL https://acb-landing.web.app) and is served on **https://albertocarbonell.dev**. `www.albertocarbonell.dev`, `albertocarbonell.es` and `www.albertocarbonell.es` are Hosting custom domains that redirect (301) to it; their DNS is in GoDaddy (an `A` record to `199.36.158.100` plus a `hosting-site=acb-landing` `TXT` on each apex, which must stay for Firebase to keep verifying ownership, and `www` as a `CNAME` to `acb-landing.web.app`).

The agent runs as a separate Cloud Run service that the browser calls directly at `AGENT_URL`, not through a Firebase Hosting rewrite, which buffers the stream and retries long requests ([ADR 0002](adr/0002-agent-direct-cloud-run-url.md)). Only `/mcp` goes through the rewrite (see [The agent URL](development.md#the-agent-url)).

### Security headers

Every page gets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a Content Security Policy (`frame-ancestors 'none'`, no plugins, `connect-src` limited to the site and the agent's origin). A static export can't use nonces, so the CSP allows each inline script by its hash: the theme script and the RSC payloads Next writes, which change with every build. So `pnpm build` ends by writing `out/firebase.json` (`scripts/hosting-config.mts`, `src/lib/security-headers.ts`): the committed `firebase.json` plus the CSP for that build and its `NEXT_PUBLIC_AGENT_URL`. Every inline script has to be hashed, Next's own included, or the page doesn't hydrate, and those hashes only exist once the build has run, so the CSP can't be committed. The deploy ships that file (`firebase deploy --config out/firebase.json`); the committed one has no CSP and isn't deployed on its own: edit headers, rewrites and the rest there, and the CSP in `src/lib/security-headers.ts`. The browser tests serve every page with those headers and fail on any CSP violation.

### Repository variables

The deploy jobs run only on `main` and only once `GCP_PROJECT_ID` and `AGENT_URL` are set. They use these repository variables:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `acb-landing` |
| `GCP_WIF_PROVIDER` | `projects/864363287015/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA` | `github-deploy@acb-landing.iam.gserviceaccount.com` |
| `SITE_URL` | `https://albertocarbonell.dev`: URL the smoke check hits (defaults to `https://<GCP_PROJECT_ID>.web.app`) |
| `REDIRECT_HOSTS` | `www.albertocarbonell.dev albertocarbonell.es www.albertocarbonell.es`: hosts the smoke check expects to 301 to `SITE_URL` |
| `AGENT_URL` | The agent service's URL; also inlined into the site as `NEXT_PUBLIC_AGENT_URL`. Without it nothing deploys (the tested build then points at the local default, `http://localhost:8080`) |
| `AGENT_STORE` | Optional: unset deploys `firestore`, whose database must exist ([below](#the-firestore-database)). `memory` is refused in production (the service fails to start) |

The Workload Identity provider only accepts GitHub OIDC tokens from this repository (matched by repository and owner id, so a renamed or re-created repo can't reuse it) on `refs/heads/main`. The deploy service account `github-deploy` can only be impersonated through that provider and holds two roles: Firebase Hosting Admin, and Service Usage Viewer (firebase-tools checks the Hosting API is enabled before deploying). It has no keys.

### Smoke check

After deploying, `deploy-site` checks the live page is the tested build, then a **smoke check** (`scripts/smoke-check.sh`, runnable locally) fails the workflow unless `SITE_URL` answers 200 with a page containing "Alberto Carbonell" and the [security headers](#security-headers), and every host in `REDIRECT_HOSTS` answers 301 over http and https and ends on `SITE_URL`. Each check gets five attempts, 10 s apart.

## Agent deploy

The `deploy-agent` job runs on `main` once the `AGENT_URL` variable is set. It takes the tested bundle, builds `agent/Dockerfile` (just the bundle on a pinned `node:24-slim`), pushes it to Artifact Registry (`europe-southwest1-docker.pkg.dev/acb-landing/agent/agent:<sha>`) and deploys it by digest to the Cloud Run service `agent` in `europe-southwest1`: scale to zero, at most one instance (see [Guardrails](guardrails.md#in-memory)), running as `agent-runtime`, with `ANTHROPIC_API_KEY` from the Secret Manager secret `anthropic-api-key`, `CONTACT_EMAIL` from the secret `contact-email` and `ANSWER_SIGNING_KEY` from the secret `answer-signing-key` (all readable only by `agent-runtime`; the address never goes through GitHub variables or the workflow, as the repo and its Actions logs are public), `ALLOWED_ORIGINS` set to `SITE_URL`, and `AGENT_STORE` from the variable of the same name (`firestore` when unset, never `memory`; see [Shared store](guardrails.md#shared-store)) with `FIRESTORE_PROJECT_ID` set to `GCP_PROJECT_ID`. The model and its prices are the code defaults ([configuration](agent.md#configuration)). The service's public (`allUsers`) invoker binding was set once by hand; deploys never change IAM, so `github-deploy` only has Cloud Run Developer, Service Account User on `agent-runtime` and Artifact Registry Writer on the `agent` repository.

The rollout keeps the serving revision until the new one has passed:

1. It records the revision serving 100% of traffic (a split stops the job before anything changes).
2. It deploys the new revision with `--no-traffic` under the tag `candidate`, which gives it its own URL.
3. `scripts/agent-smoke-check.sh --agent-only` runs against that tag URL: `/health`, that `/mcp` lists the five tools, that `get_contact` returns an email (without printing it), that `/stats` answers the weekly JSON to any origin, that `/chat` allows the site's origin (CORS preflight) rejects an invalid request with 400, and refuses an earlier answer without its signature (so the revision signs answers). It never calls the model, so a deploy costs nothing. If it fails, the job stops and the previous revision keeps serving.
4. Traffic moves to the new revision (`update-traffic --to-revisions <new>=100`), and the full smoke check runs on `AGENT_URL`, adding `/mcp` on the site's domain (through the Hosting rewrite). If that fails, traffic goes back to the recorded revision.
5. The `candidate` tag is removed, pass or fail, so no extra public URL outlives the job.

Traffic stays pinned to a named revision after this, so a manual `gcloud run deploy` doesn't take traffic on its own: move it with `gcloud run services update-traffic agent --region europe-southwest1 --to-revisions <revision>=100` (or `--to-latest`). The site deploys only after this job succeeds.

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
# Deletes rate-limit windows once they end, so the collection doesn't grow.
gcloud firestore fields ttls update expireAt --collection-group rateLimits --enable-ttl --project "$PROJECT"
# Deletes each key's daily quota document once its day is over.
gcloud firestore fields ttls update expireAt --collection-group dailySpend --enable-ttl --project "$PROJECT"
```

The deploy uses `firestore` unless the repository variable `AGENT_STORE` says otherwise, so the database must exist before the agent's first deploy; until then the new revision can't reach its store and requests answer `500`. `roles/datastore.user` is project-wide (IAM conditions can't narrow it to collections); nothing else lives in this project's Firestore.

#### Alerts

The Cloud Monitoring alert policies: [Logs and alerts](logs-and-alerts.md#alerts-cloud-monitoring).

### `/mcp` rate-limit check

`scripts/mcp-rate-limit-check.sh`, by hand, never in CI: it uses up your own one-minute `/mcp` window for a minute. Run it once after a deploy that changes the rate limits, the client-IP rule or the Hosting rewrite, from your own machine, and paste its output into the issue; it prints only counts and status codes, never a URL or an address:

```bash
scripts/mcp-rate-limit-check.sh https://albertocarbonell.dev "$AGENT_URL" [per-ip-limit]
```

The limit defaults to `RATE_LIMIT_MCP_PER_MINUTE`, else the code default; pass it if the service is configured otherwise. After waking the service on `/health`, it runs three phases, each `ok` or `FAIL` (exit code 1 if any fails):

1. **Through the site**: MCP `tools/list` calls to the site's `/mcp` until one is refused with `429`. Proves the rewrite's traffic is limited per visitor: if Hosting's peer weren't recognised, every visitor would share one key and the count would still stop, but phase 2 would then be allowed. Fewer allowed than the limit just means part of the window was already used. If the refusal comes in a window's last 10 s, it waits for the next window and starts again.
2. **Direct to the agent**: one call to `$AGENT_URL/mcp`, which must be refused: the same visitor gets the same key through the rewrite and directly ([Client IP](guardrails.md#client-ip)).
3. **Forged `X-Forwarded-For`**: five calls to each URL with made-up addresses (IPv4, IPv6 in a fresh `/64`, a two-entry chain), which must all be refused: forging the header doesn't buy a fresh window, because the key is the entry Cloud Run appends (#36's criterion, measured live).

Against a local agent (`PORT=8090 pnpm agent:dev`, memory store) phases 1 and 2 pass but phase 3 fails: with no Cloud Run front end appending the real address, the agent takes the forged value as the caller. `agent/src/mcp-rate-limit-check.test.ts` runs the script against a local agent behind a stand-in front end, in the agent tests.

## Ranges refresh

`.github/workflows/ranges-refresh.yml` runs every Monday (and on manual dispatch): it runs `pnpm agent:ranges`, which downloads Google's three IP range lists (see [Client IP](guardrails.md#client-ip)), validates each (the published shape, at least one prefix, and no list down to less than half its committed size) and rewrites `agent/src/google-ranges.json` only if a list's prefixes changed (a new publication time alone is no change). When the snapshot changed, it force-pushes a commit to the fixed branch `ranges-refresh` and opens a PR from it to the branch the run started on, or updates the one already open; otherwise it does nothing. A download that fails validation fails the run and opens no PR.

It uses only the default `GITHUB_TOKEN` (contents and pull-requests write, plus `actions: write`, needed because pushes and PRs made with that token start no workflows): it dispatches `deploy.yml` on the branch, and that run is the PR's checks, the same as any PR's: `test` and `rehearse-deploy` (which runs on pull requests and on a dispatch on any branch but `main`; the deploy jobs only run on `main`). The repository setting "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General) must be on. The log and the PR text carry counts and publication times only, never prefixes.
