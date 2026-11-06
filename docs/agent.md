# Agent service

`agent/` is a separate TypeScript service (pnpm workspace package) that answers questions about me. One set of read-only tools (`get_profile`, `get_experience`, `get_projects`, `get_stack`, `get_contact`) reads the same `src/shared/profile.ts` as the landing, bundled in at build time, so the agent and the page never disagree.

The tools are served twice, built on [Hono](https://hono.dev):

- as an **MCP server over Streamable HTTP** (stateless, public, read-only), with the official `@modelcontextprotocol/sdk`;
- to a **chat endpoint** that runs a Claude tool-use loop (official `@anthropic-ai/sdk`) and streams the answer and the tool calls to the browser ([chat contract](chat-contract.md)).

## Commands

```bash
pnpm agent:dev     # http://localhost:8080 (set PORT to change it), reloads on change
pnpm agent:test    # Vitest: tools, chat loop, Anthropic adapter and HTTP tests (fake model, never the real API)
pnpm agent:lint    # tsc + ESLint
pnpm agent:build   # self-contained bundle in agent/dist/main.js; run with `node agent/dist/main.js`
```

## Endpoints

| Path | What |
| --- | --- |
| `POST /mcp` | MCP endpoint (Streamable HTTP) |
| `POST /chat` | Chat with the agent, streamed as Server-Sent Events ([chat contract](chat-contract.md)) |
| `GET /health` | Health check, returns `{"status":"ok"}` |
| `GET /stats` | This and last week's usage aggregates, public JSON ([usage stats](usage-stats.md)) |

CORS on `/chat` only allows `ALLOWED_ORIGINS`; `/mcp` allows any origin, and so does `/stats`.

## Contact through the agent

The page holds no email address, and neither does the repo: the agent reads it from `CONTACT_EMAIL`. `pnpm test` fails on any address in a repo file outside reserved test domains (`example.com`, `.test`, ...) and listed third parties; run it with `CONTACT_EMAIL` set in your shell to also search for the real address's scrambled forms (CI never has it).

The contact section's "ask my agent" button scrolls to the chat and sends a canned question (`contactQuestion` in `src/shared/site-copy.ts`); the agent answers through `get_contact`, and the chat links any address in an answer to `mailto:`. Other links in an answer only render as links when they point to the site or a host the tools' content links to (`src/lib/link-hosts.ts`, derived from `src/shared/profile.ts`); any other URL, e.g. one a prompt injection planted, renders as text.

If `/chat` answers 503 or 429, or the stream ends in an error, the page calls `POST /mcp` `tools/call get_contact` on the agent's own URL instead (no model, no spend; open to any origin, under the MCP rate limit) and says so in the chat. If that fails too, or without JavaScript, it shows a LinkedIn link.

## Configuration

Environment variables (none are required to run the MCP server; nothing secret is committed). The schema that reads them is `agent/src/config.ts`; how production sets them is in [Deploy](deploy.md#agent-deploy).

| Variable | Default | What |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | Claude API key. Unset: `POST /chat` answers `503 unavailable`. |
| `ANSWER_SIGNING_KEY` | unset | Key that signs the chat's answers (see [Signed answers](chat-contract.md#signed-answers)), at least 32 characters; Secret Manager in production. Required with `NODE_ENV=production`, where the agent refuses to start without it. Unset elsewhere: each process makes its own, so a restart refuses the answers it signed before. |
| `CONTACT_EMAIL` | unset | The address `get_contact` gives out. It's in no repo file (Secret Manager in production). Unset: `get_contact` returns LinkedIn and GitHub only and says there's no email, so the agent points to LinkedIn. |
| `AGENT_MODEL` | `claude-haiku-5-5` | Claude model for the chat (Haiku 5.5: the cheapest current model) |
| `AGENT_EFFORT` | `low` | `low` / `medium` / `high` / `xhigh` / `max` |
| `AGENT_MAX_TOKENS` | `4096` | Output-token cap per model call |
| `AGENT_MAX_REQUEST_TOKENS` | `8192` | Output-token budget for a whole chat request, shared by all its model calls (each gets the smaller of `AGENT_MAX_TOKENS` and what's left) |
| `AGENT_MAX_ITERATIONS` | `5` | Max model calls per chat request (each one after the first reads tool results) |
| `ALLOWED_ORIGINS` | `http://localhost:3000,https://albertocarbonell.dev` | Comma-separated browser origins allowed to call `/chat` (CORS) |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `10` | Requests per client IP per minute to `/chat` |
| `RATE_LIMIT_MCP_PER_MINUTE` | `60` | Requests per client IP per minute to `/mcp` |
| `RATE_LIMIT_STATS_PER_MINUTE` | `30` | Requests per client IP per minute to `/stats` (the page reads it once per load) |
| `RATE_LIMIT_CHAT_GLOBAL_PER_MINUTE` | `60` | Requests per minute to `/chat` from all clients together (the global ceiling) |
| `RATE_LIMIT_MCP_GLOBAL_PER_MINUTE` | `600` | Requests per minute to `/mcp` from all clients together |
| `RATE_LIMIT_STATS_GLOBAL_PER_MINUTE` | `300` | Requests per minute to `/stats` from all clients together |
| `MONTHLY_SPEND_CAP_USD` | `4` | Estimated model spend per UTC month before the chat closes (`0` turns it off). Keep it under the provider's spend limit (see [Guardrails](guardrails.md#provider-spend-limit)) |
| `ALERT_CHAT_ERROR_RATE` | `0.2` | The `chat_error_rate` alert event fires when more than this share (0 to 1) of the last hour's streamed chat requests ended in an error (see [Logs and alerts](logs-and-alerts.md#alert-events)) |
| `ALERT_CHAT_ERROR_MIN_REQUESTS` | `5` | Streamed chat requests the last hour needs before its error rate fires or clears the alert |
| `DAILY_SPEND_QUOTA_USD` | `0.1` | Estimated model spend per rate-limit key per UTC day before that key's chat requests are refused with `429` until midnight UTC (`0` refuses them all). See [Guardrails](guardrails.md#daily-spend-quota) |
| `AGENT_PRICE_INPUT_USD_PER_MTOK` | `AGENT_MODEL`'s list price | Input price used to estimate spend. Unset, it comes from `listPrices` in `agent/src/pricing.ts` (Claude Haiku 5.5: `0.1`, prompts up to 100K tokens); required for a model missing there, or the agent won't start. Cache writes are charged at 1.25x the input price and cache reads at the model's cache-hit price |
| `AGENT_PRICE_OUTPUT_USD_PER_MTOK` | `AGENT_MODEL`'s list price | Output price used to estimate spend (Claude Haiku 5.5: `0.5`); same rules as the input price |
| `AGENT_STORE` | `memory` | Where the rate limits, spend cap and usage stats keep their state: `memory` (this process only, lost on restart) or `firestore` (shared, durable; see [Shared store](guardrails.md#shared-store)). With `NODE_ENV=production` (set in `agent/Dockerfile`), `memory` refuses to start unless `AGENT_ALLOW_MEMORY_STORE=true` |
| `AGENT_ALLOW_MEMORY_STORE` | `false` | `true` lets the agent start in production with the memory store anyway, accepting that the spend cap resets on every cold start |
| `FIRESTORE_PROJECT_ID` | unset | GCP project of the Firestore database; required with `AGENT_STORE=firestore` |
| `FIRESTORE_DATABASE` | `(default)` | Firestore database id |
| `FIRESTORE_EMULATOR_HOST` | unset | `host:port` of a local Firestore emulator; set, the agent talks to it with no credentials |

## Running it locally

Try the chat:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm agent:dev
curl -N localhost:8080/chat -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What agents has Alberto built?"}]}'
```

`pnpm agent:dev` and the tests use the memory store (`NODE_ENV` is not `production`) and need no cloud; running the Docker image locally needs `AGENT_STORE=firestore` or `AGENT_ALLOW_MEMORY_STORE=true`. To try the [shared store](guardrails.md#shared-store), run the Firestore emulator (`gcloud emulators firestore start --host-port=localhost:8081`) and start the agent with `AGENT_STORE=firestore FIRESTORE_PROJECT_ID=demo-agent FIRESTORE_EMULATOR_HOST=localhost:8081`.

Connect Claude Code to the local server:

```bash
claude mcp add --transport http albertocarbonell http://localhost:8080/mcp
```

The deployed server is `https://albertocarbonell.dev/mcp`. Any other MCP client works the same way: point its Streamable HTTP transport at `/mcp`. To poke at it by hand, `npx @modelcontextprotocol/inspector` and connect to the same URL.
