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
| `AGENT_MAX_ITERATIONS` | `5` | Max model calls (tool-use iterations) per chat request |
| `ALLOWED_ORIGINS` | `http://localhost:3000,https://albertocarbonell.dev` | Comma-separated browser origins allowed to call `/chat` (CORS) |

Try the chat locally:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm agent:dev
curl -N localhost:8080/chat -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What agents has Alberto built?"}]}'
```

### Chat endpoint contract

The model client is an injected interface (`agent/src/model.ts`): production uses Claude (`agent/src/anthropic.ts`), tests use a scripted fake (`agent/src/fake-model.ts`), and other providers can be added behind the same interface. The loop (`agent/src/chat.ts`) keeps the agent on topic and grounded in the tools through its system prompt, caps tokens per model call and model calls per request, and returns invalid tool input to the model as an error result.

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
| 503 | `unavailable` | No model configured |

**Stream.** Otherwise `200` with `Content-Type: text/event-stream`. Each SSE frame has `event: <type>` and `data: <JSON>`, where the JSON also carries `type`. Use `fetch` and read the body (an `EventSource` can't `POST`). Events, in order of appearance:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `text` | `delta` | A piece of the answer; append it |
| `tool_call` | `id`, `name`, `input` | The agent calls a tool, e.g. `get_projects({"status":"live"})` |
| `tool_result` | `id`, `name`, `isError`, `output` | That tool's result (`output` is the tool's JSON, or `{error}`) |
| `usage` | `iteration`, `inputTokens`, `outputTokens` | Tokens spent by one model call |
| `done` | `stopReason`, `usage` | Last event of a successful turn; `usage` is the turn total |
| `error` | `code`, `message` | Last event of a failed turn; `message` is safe to show |

`stopReason` is `end_turn` (answered), `max_tokens` (answer cut by the token cap), `max_iterations` (too many tool calls; no final answer) or `refusal` (declined; a polite `text` was sent). Stream `error` codes are `unavailable` (Claude overloaded, rate-limited upstream or unreachable: retry later) and `internal`. Every stream ends with exactly one `done` or `error`. CORS on `/chat` only allows `ALLOWED_ORIGINS`; `/mcp` allows any origin.

Connect Claude Code to the local server:

```bash
claude mcp add --transport http albertocarbonell http://localhost:8080/mcp
```

Any other MCP client works the same way: point its Streamable HTTP transport at `/mcp`. To poke at it by hand, `npx @modelcontextprotocol/inspector` and connect to the same URL.

## Roadmap

Planned work is tracked in [GitHub Issues](https://github.com/acarbonellb/acb-landing-public/issues).
