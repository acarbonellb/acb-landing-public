# acb-landing-public

Personal portfolio for [albertocarbonell.dev](https://albertocarbonell.dev).

Next.js (App Router) + React + TypeScript + Tailwind CSS. Two colour schemes, Tokyo Night (default) and Tokyo Light, toggled from the header and saved in `localStorage`.

## Development

```bash
pnpm install
pnpm dev
```

Content lives in `src/content/profile.ts`.

The "ask my agent" chat calls the agent service (below) straight from the browser. Its base URL is inlined at build time from `NEXT_PUBLIC_AGENT_URL`; the chat uses `<base>/chat` and the page shows `<base>/mcp` as the public MCP endpoint. For example `NEXT_PUBLIC_AGENT_URL=https://agent.example.run.app pnpm build`. `next dev` defaults to `http://localhost:8080` (the local `pnpm agent:dev`); a production build without it shows an "agent coming soon" note instead of the chat, so the site never publishes a localhost endpoint.

## Tests

Tests check behaviour through accessible roles, text and the `data-theme` attribute, never CSS classes or markup structure.

| Suite | Command | What it covers |
| --- | --- | --- |
| Unit | `pnpm test` (`pnpm test:watch` while developing) | Components with Vitest + React Testing Library. Files sit next to the code: `src/**/*.test.tsx`. |
| Browser | `NEXT_PUBLIC_AGENT_URL=http://localhost:8080 pnpm build && pnpm test:e2e` | Playwright against the static export in `out/`, served locally on port 4173. Files live in `e2e/*.spec.ts`. The chat tests stub `<agent>/chat`, so build with an agent URL (otherwise the page shows "agent coming soon"). |

Browser tests need a Chromium: run `pnpm exec playwright install chromium` once, or point `CHROMIUM_PATH` at an existing Chromium binary.

## CI and deployment

`.github/workflows/deploy.yml` runs lint, unit tests, the agent evals (replayed, see [Evals](#evals)), build and browser tests on every push and pull request. A failing check blocks the deploy.

`next build` produces a fully static site in `out/` (`output: "export"`), deployed to **Firebase Hosting** by the same workflow on every push to `main` once the checks pass. GitHub authenticates to GCP with Workload Identity Federation, so there are no service account keys.

The workflow is skipped until these repository variables exist:

| Variable | Example |
| --- | --- |
| `GCP_PROJECT_ID` | `acb-landing` |
| `GCP_WIF_PROVIDER` | `projects/123456789/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA` | `github-deploy@acb-landing.iam.gserviceaccount.com` |

`AGENT_URL` (optional) is passed to the build as `NEXT_PUBLIC_AGENT_URL`; without it the deployed page shows "agent coming soon" instead of the chat.

The agent service (below) will run as a separate Cloud Run service, exposed under `/api/agent` through a Firebase Hosting rewrite.

## Agent service

`agent/` is a separate TypeScript service (pnpm workspace package) that answers questions about me. One set of read-only tools (`get_profile`, `get_experience`, `get_projects`, `get_stack`, `get_contact`) reads the same `src/content/profile.ts` as the landing, bundled in at build time, so the agent and the page never disagree.

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

### Configuration

Environment variables (none are required to run the MCP server; nothing secret is committed):

| Variable | Default | What |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | Claude API key. Unset: `POST /chat` answers `503 unavailable`. |
| `AGENT_MODEL` | `claude-opus-5-5` | Claude model for the chat |
| `AGENT_EFFORT` | `low` | `low` / `medium` / `high` / `xhigh` / `max` |
| `AGENT_MAX_TOKENS` | `4096` | Output-token cap per model call |
| `AGENT_MAX_REQUEST_TOKENS` | `8192` | Output-token budget for a whole chat request, shared by all its model calls (each gets the smaller of `AGENT_MAX_TOKENS` and what's left) |
| `AGENT_MAX_ITERATIONS` | `5` | Max model calls (tool-use iterations) per chat request |
| `ALLOWED_ORIGINS` | `http://localhost:3000,https://albertocarbonell.dev` | Comma-separated browser origins allowed to call `/chat` (CORS) |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `10` | Requests per client IP per minute to `/chat` |
| `RATE_LIMIT_MCP_PER_MINUTE` | `60` | Requests per client IP per minute to `/mcp` |
| `MONTHLY_SPEND_CAP_USD` | `20` | Estimated model spend per UTC month before the chat closes (`0` turns it off) |
| `AGENT_PRICE_INPUT_USD_PER_MTOK` | `4` | Input price used to estimate spend (Claude Opus 5.5; cached input counts as full input) |
| `AGENT_PRICE_OUTPUT_USD_PER_MTOK` | `20` | Output price used to estimate spend |
| `TRUSTED_PROXY_HOPS` | `1` | Proxies that append to `X-Forwarded-For`; the client IP is the entry this many from the end (Cloud Run: 1). Must be at least 1 |

Try the chat locally:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm agent:dev
curl -N localhost:8080/chat -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What agents has Alberto built?"}]}'
```

### Chat endpoint contract

The model client is an injected interface (`agent/src/model.ts`): production uses Claude (`agent/src/anthropic.ts`), tests use a scripted fake (`agent/src/fake-model.ts`), and other providers can be added behind the same interface. The loop (`agent/src/chat.ts`) keeps the agent on topic and grounded in the tools through its system prompt, caps output tokens per model call and per request (one budget shared by all the request's calls) and model calls per request, and returns invalid tool input to the model as an error result. The wire types and limits below live in `src/lib/chat-contract.ts`, imported by both the site and the agent.

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
| `usage` | `iteration`, `inputTokens`, `outputTokens`, `estimated?` | Tokens spent by one model call (`estimated: true` when the call was cut off and is charged at its cap) |
| `done` | `stopReason`, `usage` | Last event of a successful turn; `usage` is the turn total |
| `error` | `code`, `message` | Last event of a failed turn; `message` is safe to show |

`stopReason` is `end_turn` (answered), `max_tokens` (answer cut by the per-call cap, or the request's token budget ran out), `max_iterations` (too many tool calls; no final answer) or `refusal` (declined; a polite `text` was sent). Stream `error` codes are `unavailable` (Claude overloaded, rate-limited upstream or unreachable: retry later) and `internal`. Every stream ends with exactly one `done` or `error`. CORS on `/chat` only allows `ALLOWED_ORIGINS`; `/mcp` allows any origin.

### Guardrails

- **Per-IP rate limits** on `/chat` and `/mcp`, counted separately (`agent/src/rate-limit.ts`, fixed one-minute window). Over the limit, `/chat` answers the `429 rate_limited` JSON above and `/mcp` answers `429` with `Retry-After` and a JSON-RPC error `{"code":-32000,"data":{"code":"rate_limited","retryAfterSeconds"}}`.
- **Per-request token cap**: one output-token budget (`AGENT_MAX_REQUEST_TOKENS`) shared by all the model calls of a request; when it runs out the turn ends with `stopReason: "max_tokens"`.
- **Monthly spend cap** (`agent/src/spend-cap.ts`): before calling the model, each chat request reserves its worst-case cost (its whole output budget plus a generous input estimate) and is refused with `503 unavailable` if that doesn't fit in what's left of `MONTHLY_SPEND_CAP_USD` this UTC month, so concurrent requests can't overshoot together. Each model call's actual `usage` is then charged and the unused reservation released. A call cut off because the visitor left is still charged, conservatively, at its output cap plus its input. MCP tools cost nothing and keep working.
- Both sit behind interfaces injected through `AppDeps` (`RateLimiter`, `SpendCap`, with an injectable clock).

**The spend cap is in memory, per instance, and resets on every cold start.** It is a soft guard against runaway use, not a billing limit: Cloud Run scales to zero (a cold start begins the month again at $0) and each extra instance gets its own full budget; the rate limits are per instance too. Durable, global limits need a shared store, which is infrastructure for #17 and out of scope here (implement `SpendCap`/`RateLimiter` over Firestore or Redis and inject them in `createApp`). Until then:

- **Set a monthly spend limit in the Anthropic Console** for the API key's workspace: that is the hard backstop.
- **Deploy the agent with Cloud Run `--max-instances=1`**, so one in-memory budget covers all traffic between cold starts.

Connect Claude Code to the local server:

```bash
claude mcp add --transport http albertocarbonell http://localhost:8080/mcp
```

Any other MCP client works the same way: point its Streamable HTTP transport at `/mcp`. To poke at it by hand, `npx @modelcontextprotocol/inspector` and connect to the same URL.

### Evals

The unit tests use a scripted fake model, so they prove the loop and tools work, not that a real model follows the system prompt. The evals check that: about 30 eval cases (`agent/evals/cases/index.ts`) of five kinds: off-topic (trivia, maths, coding help, also after a friendly turn), mixed (a question about me plus an unrelated one), injection, on-topic and unknown (things the tools don't cover). They run through the real chat loop and tools; only the model is swapped. Why record/replay: [ADR 0001](docs/adr/0001-agent-evals-record-replay.md).

```bash
pnpm agent:eval                  # live run: real model, writes recordings and the report
pnpm agent:eval:replay           # replays the committed recordings, rewrites agent/evals/report.md
pnpm agent:eval:replay --check   # CI: no model, no network, no API key; writes nothing
```

**Recording (live, on your machine).** `pnpm agent:eval` defaults to a local model through LM Studio's Anthropic-compatible API, so it's free: start LM Studio's server with `qwen/qwen3.5-9b` loaded, then run it as is (it uses `ANTHROPIC_BASE_URL=http://localhost:1234`, `ANTHROPIC_API_KEY=lmstudio`, `AGENT_MODEL=qwen/qwen3.5-9b`). Each case that completes is written to `agent/evals/recordings/<provider>/<model>/<case>.json`: every model call's request hash and response events. A case that fails (model down, an error) keeps its previous recording. Then one line with the set's metrics is appended to `agent/evals/history.jsonl` and `agent/evals/report.md` is regenerated. `--only ot01,on02` re-records some cases (still one history line, for the whole set).

Claude (or any non-local server) costs money: only with the owner's go-ahead, and the script refuses without `--paid`:

```bash
ANTHROPIC_BASE_URL=https://api.anthropic.com ANTHROPIC_API_KEY=sk-ant-... \
  AGENT_MODEL=claude-opus-5-5 AGENT_EVAL_PROVIDER=anthropic pnpm agent:eval --paid
```

Each provider/model gets its own recording set and report section; the provider label comes from `--provider`, then `AGENT_EVAL_PROVIDER`, then the server (`lmstudio` on localhost, `anthropic` otherwise). Run limits are the chat loop's code defaults (`chatLimits` in `agent/src/chat.ts`, plus the request limits in `src/lib/chat-contract.ts`), never your `AGENT_MAX_*` env.

**When to re-record.** A recording is only valid for the exact request it answered. Changing the system prompt, a tool's description or schema, `src/content/profile.ts` (tool results) or the chat limits changes the request, so `--check` fails as **stale** ("re-run `pnpm agent:eval` and commit"). Re-run it and commit the recordings, `history.jsonl` and `report.md` together. CI never re-records.

**History.** Every live run appends one line per recording set to `agent/evals/history.jsonl`: date (UTC), the commit it started from, provider, model, system prompt hash, case count and the report's metrics. Replay never appends. The report's "History" section shows the last 10 runs per set, newest first, each metric with its change from the run before (pp = percentage points). A prompt hash that changes between rows means the system prompt changed; the same hash with different numbers means the model, tools or content did (or the model just answered differently). Small local models aren't deterministic, so a couple of points of fact coverage between identical runs is noise; any leak is not.

**What CI gates.** `pnpm agent:eval:replay --check` runs in the `test` job and fails on a stale or missing recording, on any off-topic, mixed or injection case that leaks (the system prompt is the only defence, so a leak is a regression), when a set's latest history entry doesn't match its recordings (prompt hash and metrics, so a re-recording can't be committed without its history line), or when the regenerated `report.md` differs from the committed one. Tool accuracy, fact coverage and unknown handling are reported, not gated.

## Roadmap

Planned work is tracked in [GitHub Issues](https://github.com/acarbonellb/acb-landing-public/issues).
