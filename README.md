# acb-landing-public

Personal portfolio for [albertocarbonell.dev](https://albertocarbonell.dev).

Next.js (App Router) + React + TypeScript + Tailwind CSS. Two colour schemes, Tokyo Night (default) and Tokyo Light, toggled from the header and saved in `localStorage`.

## Development

```bash
pnpm install
pnpm dev
```

Content lives in `src/shared/`: `profile.ts` is what the agent's tools serve (editing it makes the eval recordings stale), `site-copy.ts` is copy only the page shows, and `format.ts` holds the formatting helpers both use. The page's sections are listed once, in order, in `src/lib/sections.ts`.

The "ask my agent" chat calls the agent service (below) straight from the browser. Its base URL is inlined at build time from `NEXT_PUBLIC_AGENT_URL`; the chat uses `<base>/chat`. A production build shows `https://albertocarbonell.dev/mcp` as the public MCP endpoint: `firebase.json` rewrites `/mcp` on the site to the Cloud Run service `agent`. The chat can't go through that rewrite, because Hosting buffers streamed responses ([ADR 0002](docs/adr/0002-agent-direct-cloud-run-url.md)); `next dev` shows `<base>/mcp`. For example `NEXT_PUBLIC_AGENT_URL=https://agent.example.run.app pnpm build`. `next dev` defaults to `http://localhost:8080` (the local `pnpm agent:dev`); a production build without it shows an "agent coming soon" note instead of the chat, so the site never publishes a localhost endpoint.

## Tests

Tests check behaviour through accessible roles, text and the `data-theme` attribute, never CSS classes or markup structure. Both suites fake the agent with `src/testing/agent-fakes.ts`, typed against the shared contracts, so a contract change breaks the fakes at type-check (`pnpm build`). The contact fallback matrix is unit-tested; the browsers run its happy path and one fallback.

| Suite | Command | What it covers |
| --- | --- | --- |
| Unit | `pnpm test` (`pnpm test:watch` while developing) | Components with Vitest + React Testing Library. Files sit next to the code: `src/**/*.test.tsx`. |
| Browser | `NEXT_PUBLIC_AGENT_URL=http://localhost:8080 pnpm build && pnpm test:e2e` | Playwright against the static export in `out/`, served locally on port 4173. Files live in `e2e/*.spec.ts`. The `agent` fixture (`e2e/fixtures.ts`) stubs the agent's chat, MCP and stats endpoints, so build with an agent URL (otherwise the page shows "agent coming soon"). The `page` fixture serves pages with the headers from `out/firebase.json` (see [Security headers](#ci-and-deployment)) and fails a test on any CSP violation. Axe runs once, in `a11y.spec.ts`; overflow checks live in `layout.spec.ts`. |

Browser tests need Chromium and WebKit: run `pnpm exec playwright install chromium webkit` once, or point `CHROMIUM_PATH` at an existing Chromium binary (it only applies to the Chromium project). WebKit runs `e2e/mobile-menu.spec.ts`, `e2e/contact-mobile.spec.ts` and `e2e/layout.spec.ts` on an iPhone profile with a touch screen; it needs system libraries Chromium doesn't, so on a bare Linux or WSL install run `sudo pnpm exec playwright install-deps webkit` too. Linux WebKit doesn't share every iOS Safari quirk (it focuses a tapped link, for one), so check menu changes on a real iPhone as well.

## CI and deployment

`.github/workflows/deploy.yml` runs lint, unit tests, the agent evals (replayed, see [Evals](#evals)), build and browser tests on every push and pull request. A failing check blocks the deploy.

`next build` produces a fully static site in `out/` (`output: "export"`), deployed to **Firebase Hosting** by the same workflow on every push to `main` once the checks pass. GitHub authenticates to GCP with Workload Identity Federation, so there are no service account keys.

**Security headers.** Every page gets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a Content Security Policy (`frame-ancestors 'none'`, no plugins, `connect-src` limited to the site and the agent's origin). A static export can't use nonces, so the CSP allows each inline script by its hash: the theme script and the RSC payloads Next writes, which change with every build. So `pnpm build` ends by writing `out/firebase.json` (`scripts/hosting-config.mts`, `src/lib/security-headers.ts`): the committed `firebase.json` plus the CSP for that build and its `NEXT_PUBLIC_AGENT_URL`. The deploy ships that file (`firebase deploy --config out/firebase.json`); the committed one has no CSP and isn't deployed on its own. The browser tests serve every page with those headers and fail on any CSP violation.

The site lives in the GCP project `acb-landing` (Firebase site `acb-landing`, default URL https://acb-landing.web.app) and is served on **https://albertocarbonell.dev**. `www.albertocarbonell.dev`, `albertocarbonell.es` and `www.albertocarbonell.es` are Hosting custom domains that redirect (301) to it; their DNS is in GoDaddy (an `A` record to `199.36.158.100` plus a `hosting-site=acb-landing` `TXT` on each apex, which must stay for Firebase to keep verifying ownership, and `www` as a `CNAME` to `acb-landing.web.app`). The deploy job runs only on `main` and only once `GCP_PROJECT_ID` is set; it uses these repository variables:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `acb-landing` |
| `GCP_WIF_PROVIDER` | `projects/864363287015/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA` | `github-deploy@acb-landing.iam.gserviceaccount.com` |
| `SITE_URL` | `https://albertocarbonell.dev`: URL the smoke check hits (defaults to `https://<GCP_PROJECT_ID>.web.app`) |
| `REDIRECT_HOSTS` | `www.albertocarbonell.dev albertocarbonell.es www.albertocarbonell.es`: hosts the smoke check expects to 301 to `SITE_URL` |

The Workload Identity provider only accepts GitHub OIDC tokens from this repository (matched by repository and owner id, so a renamed or re-created repo can't reuse it) on `refs/heads/main`. The deploy service account `github-deploy` can only be impersonated through that provider and holds two roles: Firebase Hosting Admin, and Service Usage Viewer (firebase-tools checks the Hosting API is enabled before deploying). It has no keys.

After deploying, a **smoke check** (`scripts/smoke-check.sh`, runnable locally) fails the workflow unless `SITE_URL` answers 200 with a page containing "Alberto Carbonell" and the security headers above, and every host in `REDIRECT_HOSTS` answers 301 over http and https and ends on `SITE_URL`. Each check gets five attempts, 10 s apart.

`AGENT_URL` (optional) is passed to the build as `NEXT_PUBLIC_AGENT_URL`; without it the deployed page shows "agent coming soon" instead of the chat.

The agent service (below) runs as a separate Cloud Run service that the browser calls directly at `AGENT_URL`, not through a Firebase Hosting rewrite. The rewrite buffers the stream and retries long requests: [ADR 0002](docs/adr/0002-agent-direct-cloud-run-url.md).

**Agent deploy.** The `deploy-agent` job runs on `main` once the `AGENT_URL` variable is set. It bundles the agent (`pnpm agent:build`), builds `agent/Dockerfile` (just the bundle on `node:24-slim`), pushes it to Artifact Registry (`europe-southwest1-docker.pkg.dev/acb-landing/agent/agent:<sha>`) and deploys the Cloud Run service `agent` in `europe-southwest1`: scale to zero, at most one instance (see [Guardrails](#guardrails)), running as `agent-runtime`, with `ANTHROPIC_API_KEY` from the Secret Manager secret `anthropic-api-key` and `CONTACT_EMAIL` from the secret `contact-email` (both readable only by `agent-runtime`; the address never goes through GitHub variables or the workflow, as the repo and its Actions logs are public), `ALLOWED_ORIGINS` set to `SITE_URL`, and `AGENT_STORE` from the variable of the same name (`firestore` when unset, never `memory`; see [Shared store](#shared-store)) with `FIRESTORE_PROJECT_ID` set to `GCP_PROJECT_ID`. The model and its prices are the code defaults. The service's public (`allUsers`) invoker binding was set once by hand; deploys never change IAM, so `github-deploy` only has Cloud Run Developer, Service Account User on `agent-runtime` and Artifact Registry Writer on the `agent` repository. It runs after the site's `deploy` job. Then `scripts/agent-smoke-check.sh` checks `/health`, that `/mcp` lists the five tools both on the agent's URL and on the site's domain (through the Hosting rewrite), that `get_contact` returns an email (without printing it), that `/stats` answers the weekly JSON to any origin, that `/chat` allows the site's origin (CORS preflight) and rejects an invalid request with 400. It never calls the model, so a deploy costs nothing.

| Variable | Value |
| --- | --- |
| `AGENT_URL` | The service's URL; also inlined into the site as `NEXT_PUBLIC_AGENT_URL` |
| `AGENT_STORE` | Optional: unset deploys `firestore`, whose database must exist ([Shared store](#shared-store)). `memory` is refused in production (the service fails to start) |

## Agent service

`agent/` is a separate TypeScript service (pnpm workspace package) that answers questions about me. One set of read-only tools (`get_profile`, `get_experience`, `get_projects`, `get_stack`, `get_contact`) reads the same `src/shared/profile.ts` as the landing, bundled in at build time, so the agent and the page never disagree.

The tools are served twice, built on [Hono](https://hono.dev):

- as an **MCP server over Streamable HTTP** (stateless, public, read-only), with the official `@modelcontextprotocol/sdk`;
- to a **chat endpoint** that runs a Claude tool-use loop (official `@anthropic-ai/sdk`) and streams the answer and the tool calls to the browser.

```bash
pnpm agent:dev     # http://localhost:8080 (set PORT to change it), reloads on change
pnpm agent:test    # Vitest: tools, chat loop, Anthropic adapter and HTTP tests (fake model, never the real API)
pnpm agent:lint    # tsc + ESLint
pnpm agent:build   # self-contained bundle in agent/dist/main.js; run with `node agent/dist/main.js`
```

| Path | What |
| --- | --- |
| `POST /mcp` | MCP endpoint (Streamable HTTP) |
| `POST /chat` | Chat with the agent, streamed as Server-Sent Events |
| `GET /health` | Health check, returns `{"status":"ok"}` |
| `GET /stats` | This and last week's usage aggregates, public JSON (see [Usage stats](#usage-stats)) |

**Contact through the agent.** The page holds no email address, and neither does the repo: the agent reads it from `CONTACT_EMAIL`. `pnpm test` fails on any address in a repo file outside reserved test domains (`example.com`, `.test`, ...) and listed third parties; run it with `CONTACT_EMAIL` set in your shell to also search for the real address's scrambled forms (CI never has it). The contact section's "ask my agent" button scrolls to the chat and sends a canned question (`contactQuestion` in `src/shared/site-copy.ts`); the agent answers through `get_contact`, and the chat links any address in an answer to `mailto:`. Other links in an answer only render as links when they point to the site or a host the tools' content links to (`src/lib/link-hosts.ts`, derived from `src/shared/profile.ts`); any other URL, e.g. one a prompt injection planted, renders as text. If `/chat` answers 503 or 429, or the stream ends in an error, the page calls `POST /mcp` `tools/call get_contact` on the agent's own URL instead (no model, no spend; open to any origin, under the MCP rate limit) and says so in the chat. If that fails too, or without JavaScript, it shows a LinkedIn link.

### Configuration

Environment variables (none are required to run the MCP server; nothing secret is committed):

| Variable | Default | What |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | Claude API key. Unset: `POST /chat` answers `503 unavailable`. |
| `CONTACT_EMAIL` | unset | The address `get_contact` gives out. It's in no repo file (Secret Manager in production). Unset: `get_contact` returns LinkedIn and GitHub only and says there's no email, so the agent points to LinkedIn. |
| `AGENT_MODEL` | `claude-haiku-5-5` | Claude model for the chat (Haiku 5.5: the cheapest current model) |
| `AGENT_EFFORT` | `low` | `low` / `medium` / `high` / `xhigh` / `max` |
| `AGENT_MAX_TOKENS` | `4096` | Output-token cap per model call |
| `AGENT_MAX_REQUEST_TOKENS` | `8192` | Output-token budget for a whole chat request, shared by all its model calls (each gets the smaller of `AGENT_MAX_TOKENS` and what's left) |
| `AGENT_MAX_ITERATIONS` | `5` | Max model calls per chat request (each one after the first reads tool results) |
| `ALLOWED_ORIGINS` | `http://localhost:3000,https://albertocarbonell.dev` | Comma-separated browser origins allowed to call `/chat` (CORS) |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `10` | Requests per client IP per minute to `/chat` |
| `RATE_LIMIT_MCP_PER_MINUTE` | `60` | Requests per client IP per minute to `/mcp` |
| `MONTHLY_SPEND_CAP_USD` | `4` | Estimated model spend per UTC month before the chat closes (`0` turns it off). Keep it under the provider's spend limit (see Guardrails) |
| `ALERT_CHAT_ERROR_RATE` | `0.2` | The `chat_error_rate` alert event fires when more than this share (0 to 1) of the last hour's streamed chat requests ended in an error (see [Logs and alert events](#logs-and-alert-events)) |
| `ALERT_CHAT_ERROR_MIN_REQUESTS` | `5` | Streamed chat requests the last hour needs before its error rate fires or clears the alert |
| `AGENT_PRICE_INPUT_USD_PER_MTOK` | `AGENT_MODEL`'s list price | Input price used to estimate spend. Unset, it comes from `listPrices` in `agent/src/pricing.ts` (Claude Haiku 5.5: `0.1`, prompts up to 100K tokens); required for a model missing there, or the agent won't start. Cache writes are charged at 1.25x the input price and cache reads at the model's cache-hit price |
| `AGENT_PRICE_OUTPUT_USD_PER_MTOK` | `AGENT_MODEL`'s list price | Output price used to estimate spend (Claude Haiku 5.5: `0.5`); same rules as the input price |
| `AGENT_STORE` | `memory` | Where the rate limits, spend cap and usage stats keep their state: `memory` (this process only, lost on restart) or `firestore` (shared, durable; see [Shared store](#shared-store)). With `NODE_ENV=production` (set in `agent/Dockerfile`), `memory` refuses to start unless `AGENT_ALLOW_MEMORY_STORE=true` |
| `AGENT_ALLOW_MEMORY_STORE` | `false` | `true` lets the agent start in production with the memory store anyway, accepting that the spend cap resets on every cold start |
| `FIRESTORE_PROJECT_ID` | unset | GCP project of the Firestore database; required with `AGENT_STORE=firestore` |
| `FIRESTORE_DATABASE` | `(default)` | Firestore database id |
| `FIRESTORE_EMULATOR_HOST` | unset | `host:port` of a local Firestore emulator; set, the agent talks to it with no credentials |

Try the chat locally:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm agent:dev
curl -N localhost:8080/chat -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What agents has Alberto built?"}]}'
```

### Chat endpoint contract

The model client is an injected interface (`agent/src/model.ts`): production uses Claude (`agent/src/anthropic.ts`), tests use a scripted fake (`agent/src/fake-model.ts`), and other providers can be added behind the same interface. The loop (`agent/src/chat.ts`) keeps the agent on topic and grounded in the tools through its system prompt, caps output tokens per model call and per request (one budget shared by all the request's calls) and model calls per request, and returns invalid tool input to the model as an error result. The wire types and limits below live in `src/shared/chat-contract.ts`, imported by both the site and the agent.

**Request.** `POST /chat` with `Content-Type: application/json`. The conversation is stateless: the browser sends what it shows, ending with the new question.

```json
{ "messages": [
  { "role": "user", "content": "Who is Alberto?" },
  { "role": "assistant", "content": "A senior software engineer..." },
  { "role": "user", "content": "Is he remote?" }
] }
```

Roles alternate, start and end with `user`; at most 20 messages of 1–2000 characters; no other fields; body at most 64 KB.

**Errors before streaming** are JSON `{"error":{"code","message"}}`:

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Not JSON or fails validation (`message` says why) |
| 413 | `invalid_request` | Body too large |
| 429 | `rate_limited` | Too many requests from this IP; body adds `retryAfterSeconds`, header `Retry-After` (exposed to the browser via CORS) |
| 503 | `unavailable` | No model configured, or the monthly spend cap is reached (then body adds `resetsAt`, the ISO time the budget renews, and `message` says so) |

**Stream.** Otherwise `200` with `Content-Type: text/event-stream`. Each SSE frame has `event: <type>` and `data: <JSON>`, where the JSON also carries `type`. Use `fetch` and read the body (an `EventSource` can't `POST`). Events, in order of appearance:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `text` | `delta` | A piece of the answer; append it |
| `tool_call` | `id`, `name`, `input` | The agent calls a tool, e.g. `get_projects({"status":"in-progress"})` |
| `tool_result` | `id`, `name`, `isError`, `output` | That tool's result (`output` is the tool's JSON, or `{error}`) |
| `usage` | `iteration`, `inputTokens`, `outputTokens`, `cacheWriteInputTokens?`, `cacheReadInputTokens?`, `estimated?` | Tokens spent by one model call (`estimated: true` when the call was cut off and is charged at its cap). `inputTokens` counts all input; the optional cache fields say how many of those were written to or read from the prompt cache (absent: none) |
| `done` | `stopReason`, `usage` | Last event of a chat request that answered; `usage` is the request's total, with the same token fields (cache fields included) as a `usage` event |
| `error` | `code`, `message` | Last event of a chat request that failed; `message` is safe to show |

`stopReason` is `end_turn` (answered), `max_tokens` (answer cut by the per-call cap, or the request's token budget ran out), `max_iterations` (too many tool calls; no final answer) or `refusal` (declined; a polite `text` was sent). Stream `error` codes are `unavailable` (Claude overloaded, rate-limited upstream, unreachable, or the provider's spend or billing limit reached: retry later) and `internal`. Every stream ends with exactly one `done` or `error`. CORS on `/chat` only allows `ALLOWED_ORIGINS`; `/mcp` allows any origin.

### Guardrails

- **Per-IP rate limits** on `/chat` and `/mcp`, counted separately (`agent/src/rate-limit.ts`, fixed one-minute window). Over the limit, `/chat` answers the `429 rate_limited` JSON above and `/mcp` answers `429` with `Retry-After` and a JSON-RPC error `{"code":-32000,"data":{"code":"rate_limited","retryAfterSeconds"}}`.
- **Client IP** (`agent/src/client-ip.ts`): the right-most `X-Forwarded-For` entry, which Cloud Run appends and a caller can't forge. `/chat` and `/stats` are never behind Firebase Hosting and always key on it. Only on `/mcp`, through the site's rewrite, that entry is Hosting's own and the visitor is the entry to its left (measured in #36: Hosting sends `<visitor>,<hosting>` and drops forged values). So `/mcp` skips the right-most entry only when it is in Google's [user-triggered fetchers ranges](https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json), where #36 saw Hosting's peer. A caller that can send from those ranges could still choose its key. A snapshot of the list ships with the agent (`agent/src/google-ranges.json`); refresh it with `pnpm agent:ranges` and commit the result.
- **Rate-limit key**: the client IP, or its `/64` prefix for IPv6 (`rateLimitKeyFor`), so rotating addresses inside one network's block doesn't buy a fresh window; clients sharing a `/64` share a limit. IPv4 addresses, IPv4-mapped ones included, are keyed whole.
- **Per-request token cap**: one output-token budget (`AGENT_MAX_REQUEST_TOKENS`) shared by all the model calls of a request; when it runs out the request ends with `stopReason: "max_tokens"`.
- **Monthly spend cap** (`agent/src/spend-cap.ts`): before calling the model, each chat request reserves its worst-case cost (its whole output budget plus a generous input estimate) and is refused with `503 unavailable` if that doesn't fit in what's left of `MONTHLY_SPEND_CAP_USD` this UTC month, so concurrent requests can't overshoot together. Each model call's actual `usage` is then charged and the unused reservation released. A call cut off because the visitor left is still charged, conservatively, at its output cap plus its input. MCP tools cost nothing and keep working. The chat shows the visitor the date it reopens (`resetsAt`).
- **Provider spend limit**: the Anthropic workspace has its own hard limit of $5 per month, set in the Claude Console. The code cap defaults to $4, below it, because the code cap only estimates spend (list prices from `agent/src/pricing.ts`, at the requested model's rates) and is the one with a graceful answer: it refuses before calling the model and says when the chat reopens. The provider limit is the backstop if the estimate is ever off; if it is hit (a 400 naming the usage limit, or a 402 `billing_error` when there is no credit), `agent/src/anthropic.ts` treats it like an outage and the stream ends with `unavailable`, not `internal`. Raise both together, keeping the code cap under the provider's. Hitting the provider limit logs the `provider_limit` alert event, since it means the two have drifted apart.
- Both sit behind interfaces injected through `AppDeps` (`RateLimiter`, `SpendCap`, with an injectable clock), each with two implementations: in memory (local development and tests) and over a shared document store (production). `AGENT_STORE` picks one, in the production composer (`agent/src/compose.ts`).

#### Shared store

With `AGENT_STORE=firestore` the rate limits and the spend cap live in Firestore, so they are shared by every Cloud Run instance and survive cold starts: the month's spend no longer starts again at $0 when the service scales to zero. The agent talks to Firestore's REST API with plain `fetch` and the service account's token from the metadata server, so the bundle stays self-contained ([ADR 0003](docs/adr/0003-agent-firestore-over-rest.md)).

- **Rate limits**: one document per limiter and client, `rateLimits/<chat|mcp>:<key>` (the rate-limit key, URL-encoded), holding the current one-minute window (`start`, `count`) and `expireAt`, its end.
- **Spend**: one document per UTC month, `spend/<YYYY-MM>`, holding `spentUsd`, the `holds` of the requests running (each reservation's worst case and `expireAt`) and `alerted`, the alert events already fired this month (see [Logs and alert events](#logs-and-alert-events)). A reservation whose instance died before settling stops counting after 15 minutes (Cloud Run's request timeout is 5); what that request spent stays charged.
- **Usage**: one document per ISO week, `usage/<YYYY-Www>`, with the week's aggregates (see [Usage stats](#usage-stats)).
- **Concurrency**: every change is read, then committed with a precondition on the document's `updateTime` (or that it doesn't exist yet); if another request wrote in between, it is re-read and re-applied. So parallel requests can't both pass the limit or both fit under the same remaining budget.
- **Cost**: a chat request is about one write for its rate limit, one to reserve, one per model call, one to settle and one for its usage stats; an MCP request is two (rate limit, usage). That is far inside Firestore's free tier (20K writes and 50K reads a day, on the `(default)` database).
- **Failure**: every Firestore REST call (and the metadata server's token request) gives up after 3 s, so a hanging store fails fast instead of holding the request. Each route then follows its own policy (`agent/src/app.ts`):
  - `/mcp` **fails open**: a failed rate-limit check lets the request through, so `get_contact` keeps answering. It is the contact fallback when the chat is down, and it costs nothing.
  - `/stats` **fails open** on its rate limit too, and answers `503 unavailable` JSON if the aggregates can't be read; the page then hides its usage line.
  - `/chat` **fails closed**: a failed rate-limit check or reservation answers `503 unavailable` JSON (`errorMessages.unavailable`), so the chat never starts unbudgeted, and the page falls back to `/mcp` for the contact.
  - Any other error a route doesn't handle reaches the app's error handler, which answers in the route's contract (JSON on `/chat` and `/stats`, a JSON-RPC error `-32603` with `data.code: "unavailable"` on `/mcp`, both `503`), never a plain-text `500`; the CORS headers stay on.
  - If recording a model call's usage fails once the answer is streaming, the error is logged, the answer goes on, and the request's reservation stays until it expires, covering that call's cost. Recording usage stats is best effort everywhere.
  - Errors are logged with the collection only (`rateLimits`, `spend`, `usage`), never the document id, which can hold a client IP, nor Firestore's response body.

Setting it up (once, by hand; `PROJECT=acb-landing`):

```bash
gcloud services enable firestore.googleapis.com --project "$PROJECT"
gcloud firestore databases create --project "$PROJECT" --location europe-southwest1 --type firestore-native
# Read and write documents, nothing else: the minimum predefined role.
gcloud projects add-iam-policy-binding "$PROJECT" --role roles/datastore.user \
  --member "serviceAccount:agent-runtime@$PROJECT.iam.gserviceaccount.com"
# Deletes rate-limit windows once they end, so the collection doesn't grow.
gcloud firestore fields ttls update expireAt --collection-group rateLimits --enable-ttl --project "$PROJECT"
```

The deploy uses `firestore` unless the repository variable `AGENT_STORE` says otherwise, so the database must exist before the agent's first deploy; until then the new revision can't reach its store and requests answer `500`. `roles/datastore.user` is project-wide (IAM conditions can't narrow it to collections); nothing else lives in this project's Firestore.

**Backstops**, whichever the store:

- **Set a monthly spend limit in the Anthropic Console** for the API key's workspace: the cap counts estimated spend, so that is the hard limit.
- In memory, the cap is per instance and resets on every cold start. So in production (`NODE_ENV=production`, set in `agent/Dockerfile`) the agent refuses to start with `AGENT_STORE=memory` and says why, unless `AGENT_ALLOW_MEMORY_STORE=true` accepts it explicitly; the deploy never sets that. The agent is also deployed with Cloud Run `--max-instances=1`.

Locally, `pnpm agent:dev` and the tests use memory (`NODE_ENV` is not `production`) and need no cloud; running the Docker image locally needs `AGENT_STORE=firestore` or `AGENT_ALLOW_MEMORY_STORE=true`. To try the shared store, run the Firestore emulator (`gcloud emulators firestore start --host-port=localhost:8081`) and start the agent with `AGENT_STORE=firestore FIRESTORE_PROJECT_ID=demo-agent FIRESTORE_EMULATOR_HOST=localhost:8081`.

Connect Claude Code to the local server:

```bash
claude mcp add --transport http albertocarbonell http://localhost:8080/mcp
```

The deployed server is `https://albertocarbonell.dev/mcp`. Any other MCP client works the same way: point its Streamable HTTP transport at `/mcp`. To poke at it by hand, `npx @modelcontextprotocol/inspector` and connect to the same URL.

### Usage stats

The agent keeps weekly aggregates of its own traffic (`agent/src/usage.ts`) and serves them publicly; the page reads them in the browser and shows one line under the chat, e.g. `// this week: 24 questions answered · p50 2 s · 4% errors · $0.03` (last week's figures until this week has an answer; no line at all if `/stats` fails or nothing was answered).

**What is recorded.** Each chat request, once it ends, is folded into its ISO week's document: the request, its outcome, its tokens (all model calls, estimated ones included), its estimated cost (the model's list prices, `agent/src/pricing.ts`) and two latencies, from arrival to the end of the stream and to the first text, as counts in fixed histogram buckets (250 ms … 5 min, plus an unbounded one). Outcomes are the stream's `stopReason` (`end_turn`, `max_tokens`, `max_iterations`, `refusal`), `error:<code>` for a stream `error`, `aborted` when the visitor left mid-answer, and `http_429` / `http_503` for refusals before streaming (no latency for those). Malformed requests (400, 413) aren't recorded. Each MCP HTTP request served is counted, nothing more (a client's session is several: initialize, list, calls); `/stats` itself isn't counted. **No message content and no IPs** are ever recorded. Recording is best effort: a failure is logged and the request goes on.

**Document**, `usage/<YYYY-Www>` (e.g. `usage/2026-W45`, ISO weeks from Monday 00:00 UTC), in the same store as the guardrails (`AGENT_STORE`; in memory it is per instance and lost on restart):

```json
{
  "week": "2026-W45",
  "chat": {
    "requests": 26,
    "outcomes": { "end_turn": 23, "max_tokens": 1, "error:unavailable": 1, "http_429": 1 },
    "inputTokens": 120000, "outputTokens": 9000, "costUsd": 0.0165,
    "totalMs": { "2000": 14, "3000": 8, "7500": 3 },
    "firstTextMs": { "1000": 20, "2000": 4 }
  },
  "mcp": { "requests": 12 },
  "errorWindow": { "1793872800000": { "streamed": 3, "errors": 0 } },
  "alerted": { "chat_error_rate": false }
}
```

Histogram keys are bucket upper bounds in ms (`inf` past the last). `errorWindow` and `alerted` serve the `chat_error_rate` alert event: streamed requests and errors per 10-minute bucket (keyed by its start, ms since epoch), pruned past the hour, and whether the alert is in effect. `/stats` doesn't serve them.

**`GET /stats`** answers this week's and the previous week's aggregates, any origin (CORS `*`), `Cache-Control: public, max-age=300`, under the `/mcp` rate limit (the same per-IP count); `503 unavailable` if the store can't be read. The types are `StatsResponse` in `src/shared/stats-contract.ts`:

```json
{
  "current": {
    "week": "2026-W45", "startsAt": "2026-11-02T00:00:00.000Z",
    "chat": {
      "requests": 26, "answered": 24, "outcomes": { "end_turn": 23, "max_tokens": 1, "error:unavailable": 1, "http_429": 1 },
      "inputTokens": 120000, "outputTokens": 9000, "costUsd": 0.0165, "errorRate": 0.04,
      "latency": { "p50Ms": 2000, "p95Ms": 7500 }, "firstText": { "p50Ms": 1000, "p95Ms": 2000 }
    },
    "mcp": { "requests": 12 }
  },
  "previous": { "week": "2026-W44", "...": "same shape" }
}
```

`answered` counts the four `stopReason` outcomes. `errorRate` is `error:*` outcomes over the requests that streamed (all but `http_429` and `http_503`), `null` if none did. Percentiles are the upper bound of the bucket they fall in (an upper estimate), `null` with no samples or past the last bucket.

**Cost**: one more Firestore write per chat request (also for a 429 or 503) and per MCP request, and two document reads per `/stats` call (cached by browsers for 5 minutes). Every chat and MCP request in a week writes the same document; at this site's traffic that is far below Firestore's limit of about one sustained write per second per document, and a conflict only retries. One small document a week accumulates; no TTL is needed.

### Logs and alert events

The agent logs one JSON object per line (`agent/src/log.ts`), which Cloud Logging parses natively: `severity` becomes the entry's severity, `message` its summary, and every other field lands in `jsonPayload`. `INFO` lines go to stdout, `WARNING` and `ERROR` to stderr. **No line carries message content, a client IP or the contact email**: only counts, ids, outcomes, months and weeks, and error messages that are scrubbed where they're made (Firestore errors name the collection, never the document id, which can hold a client IP; `agent/src/firestore.ts`). The startup banner (`main.ts`) is plain text.

**Fields on every line**

| Field | Type | What |
| --- | --- | --- |
| `severity` | `"INFO"` \| `"WARNING"` \| `"ERROR"` | Cloud Logging severity |
| `event` | string | Stable event name (the tables below). Alerts and queries match on this, never on `message` |
| `message` | string | Human-readable summary; wording may change |
| `requestId` | string (UUID) | Set on every line logged while serving a request, absent otherwise. Each request gets a fresh one, also sent back as the `X-Request-Id` response header, so a chat's stream, its store writes and its alert events can be tied together |

**Request events**

| `event` | Severity | Fields | When |
| --- | --- | --- | --- |
| `chat_request` | `INFO` | `outcome`, `inputTokens`, `outputTokens`, `costUsd`, `totalMs`, `firstTextMs`, `modelCalls` | Exactly once per `POST /chat` that reaches the route. `outcome` is the usage outcome (`end_turn`, `max_tokens`, `max_iterations`, `refusal`, `error:unavailable`, `error:internal`, `aborted`, `http_429`, `http_503`; see [Usage stats](#usage-stats)) or `http_400` / `http_413` for a malformed or oversized body. Tokens are all the request's model calls, estimated ones included (`0` when refused before streaming); `costUsd` is the estimate at list prices; `totalMs` / `firstTextMs` are ms from arrival to the end of the stream / the first text, `null` when there was none; `modelCalls` counts model calls (`0` when refused) |
| `chat_failed` | `ERROR` | `error`, `stack` | A chat run hit a bug (the stream ends with `error:internal`) |
| `unhandled_error` | `ERROR` | `method`, `route`, `error`, `stack` | An error no route handled (or a store failing where the route fails closed), answered `503` in the route's contract |
| `store_error` | `ERROR` | `operation`, `error`, plus `route` (`rate_limit`), `costUsd` (`spend_record`) | One store operation failed. `operation`: `rate_limit` (the route then fails open or closed), `usage_record`, `usage_stats`, `spend_record`, `spend_settle`, `provider_limit`. One line per failure: for debugging, not alerting |

`error` is always `"<Name>: <message>"`, with ` (cause: ...)` appended when the error has a cause.

**Alert events.** Each fires **once per crossing**, not once per request; the state lives in the shared store, so it holds across instances and cold starts (in memory, per instance). These are what the Cloud Monitoring log-based alerts match on (#91):

| `event` | Severity | Fields | Fires | State kept in |
| --- | --- | --- | --- | --- |
| `spend_threshold` | `WARNING` | `thresholdPercent` (`50` or `80`), `month` (`YYYY-MM`), `spentUsd`, `budgetUsd` | When a model call's charge first brings the month's `spentUsd` to at least 50%, then 80%, of `MONTHLY_SPEND_CAP_USD` (never with a `0` cap). Once each per month | `spend/<YYYY-MM>`: `alerted.spend_threshold_50`, `alerted.spend_threshold_80` |
| `spend_cap_reached` | `ERROR` | `month`, `spentUsd`, `budgetUsd`, `resetsAt` (ISO time the chat reopens: the next UTC month) | When the spend cap first refuses a chat request in the month. Once per month | `spend/<YYYY-MM>`: `alerted.spend_cap_reached` |
| `provider_limit` | `ERROR` | `month` | When a model call is refused by the provider's own spend or credit limit (a 400 naming the usage limit, or a 402 `billing_error`) and the limit wasn't already noted. Fires again only after `provider_limit_cleared` | `spend/<YYYY-MM>`: `alerted.provider_limit` (`true` while limited) |
| `provider_limit_cleared` | `INFO` | `month` | The next model call that succeeds after `provider_limit` | the same flag, set back to `false` |
| `chat_error_rate` | `ERROR` | `week` (`YYYY-Www`), `windowMinutes` (`60`), `streamed`, `errors`, `errorRate` (0 to 1), `threshold` | When, as a streamed chat request ends, the last hour's `error:*` share of streamed requests (all but `http_429` / `http_503`) goes above `ALERT_CHAT_ERROR_RATE`, with at least `ALERT_CHAT_ERROR_MIN_REQUESTS` streamed requests in the hour. Fires again only after `chat_error_rate_recovered` | `usage/<YYYY-Www>`: `alerted.chat_error_rate` (`true` while above), and `errorWindow` |
| `chat_error_rate_recovered` | `INFO` | same as `chat_error_rate` | When the hour's rate is back at or under the threshold (again with the minimum of requests) | the same flag, set back to `false` |
| `store_unavailable` | `ERROR` | `collection` (`rateLimits`, `spend` or `usage`), `error` | When a store update fails after the last one succeeded (or at the first). Fires again only after `store_recovered` | this instance's memory: the store can't record its own outage |
| `store_recovered` | `INFO` | `collection` | The next store update that succeeds after `store_unavailable` | the same |

"The last hour" is the current 10-minute bucket (UTC) and the five before it, so 50 to 60 minutes; the buckets live in the week's document, so the window starts afresh each Monday 00:00 UTC. `spentUsd` is the month's charged spend, rounded to the micro-dollar; reservations of running requests aren't in it. Spend and provider-limit state start afresh each UTC month, with the month's document.

Querying them in Cloud Logging, e.g. every alert event of the agent:

```
resource.type="cloud_run_revision" AND resource.labels.service_name="agent"
jsonPayload.event=("spend_threshold" OR "spend_cap_reached" OR "provider_limit" OR "chat_error_rate" OR "store_unavailable")
```

or one request's lines: `jsonPayload.requestId="<id>"`.

### Evals

The unit tests use a scripted fake model, so they prove the loop and tools work, not that a real model follows the system prompt. The evals check that: about 40 eval cases (`agent/evals/cases/index.ts`) of five kinds: off-topic (trivia, maths, coding help, also after a friendly turn), mixed (a question about me plus an unrelated one), injection (including long, repetitive input that tries to make it loop through tools), on-topic and unknown (things the tools don't cover, including anything it would have to say on my behalf: availability, opinions, offers, relocation, experience I don't have). They run through the real chat loop and tools; only the model is swapped, and `get_contact` gives out the placeholder `alberto@example.com` (`agent/src/evals/content.ts`), never the real address, so recordings stay deterministic and the address stays out of them. Why record/replay: [ADR 0001](docs/adr/0001-agent-evals-record-replay.md).

```bash
pnpm agent:eval                  # live run: real model, writes recordings and the report
pnpm agent:eval:replay           # replays the committed recordings, rewrites agent/evals/report.md
pnpm agent:eval:replay --check   # CI: no model, no network, no API key; writes nothing
```

**Recording (live, on your machine).** `pnpm agent:eval` defaults to a local model through LM Studio's Anthropic-compatible API, so it's free: start LM Studio's server with `qwen/qwen3.5-9b` loaded, then run it as is (it uses `ANTHROPIC_BASE_URL=http://localhost:1234`, `ANTHROPIC_API_KEY=lmstudio`, `AGENT_MODEL=qwen/qwen3.5-9b`). Each case that completes is written to `agent/evals/recordings/<provider>/<model>/<case>.json`: every model call's request hash and response events. A case that fails (model down, an error) keeps its previous recording. Then one line with the set's metrics is appended to `agent/evals/history.jsonl` and `agent/evals/report.md` is regenerated. `--only ot01,on02` re-records some cases (still one history line, for the whole set).

Claude (or any non-local server) costs money: only with the owner's go-ahead, and the script refuses without `--paid`:

```bash
ANTHROPIC_BASE_URL=https://api.anthropic.com ANTHROPIC_API_KEY=sk-ant-... \
  AGENT_MODEL=claude-haiku-5-5 AGENT_EVAL_PROVIDER=anthropic pnpm agent:eval --paid
```

Each provider/model gets its own recording set and report section; the provider label comes from `--provider`, then `AGENT_EVAL_PROVIDER`, then the server (`lmstudio` on localhost, `anthropic` otherwise). Run limits are the chat loop's code defaults (`chatLimits` in `agent/src/chat.ts`, plus the request limits in `src/shared/chat-contract.ts`), never your `AGENT_MAX_*` env.

**When to re-record.** A recording is only valid for the exact request it answered. Changing the system prompt, a tool's description or schema, `src/shared/profile.ts` (tool results) or the chat limits changes the request, so `--check` fails as **stale** ("re-run `pnpm agent:eval` and commit"). Re-run it and commit the recordings, `history.jsonl` and `report.md` together. CI never re-records.

**History.** Every live run appends one line per recording set to `agent/evals/history.jsonl`: date (UTC), the commit it started from, provider, model, system prompt hash, case count and the report's metrics, including the mean cost per case: each case's tokens at the model's list prices (`listPrices` in `agent/src/pricing.ts`, the same table as the spend cap's default prices; a local model costs $0, a model missing from the table shows n/a). Entries from before costs were recorded have none; only each set's latest entry is checked against the recordings. Replay never appends. The report opens with a summary, one row per set: model, provider, cases, quality metrics, mean tokens, latency and cost per case. The report's "History" section shows the last 10 runs per set, newest first, each metric with its change from the run before (pp = percentage points). A prompt hash that changes between rows means the system prompt changed; the same hash with different numbers means the model, tools or content did (or the model just answered differently). Small local models aren't deterministic, so a couple of points of fact coverage between identical runs is noise; any leak is not.

**On the page.** The Portfolio Agent card's results line (cases, leaks, cost per answer) is generated at build time from the latest `claude-haiku-5-5` entry of `history.jsonl` (`src/lib/eval-results.ts`), so a new live run updates it on the next deploy; never type those numbers by hand. It is not in `get_projects`, so the tool output (and the recordings) don't depend on the history.

**What CI gates.** `pnpm agent:eval:replay --check` runs in the `test` job and fails on a stale or missing recording, on any off-topic, mixed or injection case that leaks (the system prompt is the only defence, so a leak is a regression), when the gated case `on11` fails (the exact question the site's "ask my agent" button sends must get the address through `get_contact`: it's the site's contact path, [ADR 0001](docs/adr/0001-agent-evals-record-replay.md#amendment-50-the-contact-question-is-gated)), when a set's latest history entry doesn't match its recordings (prompt hash and metrics, so a re-recording can't be committed without its history line), or when the regenerated `report.md` differs from the committed one. Tool accuracy, fact coverage and unknown handling are reported, not gated.

## Roadmap

Planned work is tracked in [GitHub Issues](https://github.com/acarbonellb/acb-landing-public/issues).
