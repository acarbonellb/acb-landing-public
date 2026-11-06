# acb-landing-public

Personal portfolio for [albertocarbonell.dev](https://albertocarbonell.dev), with an agent that answers visitors' questions about me from the site's own content, in a chat on the page and over MCP.

A static Next.js site (React, TypeScript, Tailwind CSS) on Firebase Hosting, and a small TypeScript agent service on Cloud Run. Both read the same profile (`src/shared/profile.ts`), so the page and the agent never disagree.

## Architecture

```
 browser ──── static site ──────────────── Firebase Hosting
    │           (Next.js export)                  │
    │                                             │ /mcp rewrite
    │  POST /chat (SSE), GET /stats               ▼
    └──────────────────────────────────────► agent (Cloud Run)
                                              ├─ tools over profile.ts
 MCP clients ── POST /mcp ──────────────────► ├─ MCP server (Streamable HTTP)
                                              ├─ chat loop ──► Claude API
                                              └─ guardrails, usage stats
                                                     │
                                                     ▼
                                              Firestore (rate limits,
                                              spend, usage)

 GitHub Actions: lint, unit, agent and browser tests, eval replay
   ──► build once ──► deploy the tested artifacts (agent, then site)
```

- **Site**: a static export with no server. The chat calls the agent directly; the public MCP endpoint is the site's `/mcp`, rewritten to the agent.
- **Agent**: five read-only tools, served to MCP clients and to a Claude tool-use loop that streams answers to the chat. Every answer it gives is signed, so it only reads back answers it gave.
- **Store**: Firestore holds the rate limits, the spend cap, the daily quota and the weekly usage stats, shared by every instance.
- **CI**: every push runs the tests and replays the agent's eval recordings; `main` deploys the exact build that was tested.

## Running it

```bash
pnpm install
pnpm dev          # the site, on http://localhost:3000
pnpm agent:dev    # the agent, on http://localhost:8080 (the chat needs ANTHROPIC_API_KEY)
pnpm test         # unit tests; see docs/development.md for the rest
```

## Key decisions

- [Agent evals are recorded locally and replayed in CI](docs/adr/0001-agent-evals-record-replay.md): CI tests the agent against a real model's answers without calling a model.
- [The chat calls the agent's Cloud Run URL directly](docs/adr/0002-agent-direct-cloud-run-url.md): the Hosting rewrite buffers streamed responses.
- [The agent talks to Firestore over REST](docs/adr/0003-agent-firestore-over-rest.md): the bundle stays self-contained.
- [The agent signs its answers](docs/adr/0004-signed-answers.md): a stateless chat can't be fed answers the agent never gave.

## How this was built

The work is planned in [GitHub Issues](https://github.com/acarbonellb/acb-landing-public/issues): each feature starts as a spec, which is split into tickets with acceptance criteria. Coding agents implement the tickets, and I write the specs, review the changes and merge the pull requests. The files the agents read are part of that tooling: [`CLAUDE.md`](CLAUDE.md) holds the project conventions, [`AGENTS.md`](AGENTS.md) is the block that `next dev` generates for this Next.js version, and [`docs/agents/`](docs/agents/) says how to use the [issue tracker](docs/agents/issue-tracker.md), the [triage labels](docs/agents/triage-labels.md) and the [domain docs](docs/agents/domain.md). The gate is the same for every change: [CI](.github/workflows/deploy.yml) runs lint, the unit, agent and browser tests and the [eval replay](docs/evals.md), and only a build that passes is deployed.

## Docs

| Doc | What's in it |
| --- | --- |
| [Development](docs/development.md) | Content files, the agent URL at build time, the test suites |
| [Agent service](docs/agent.md) | Tools, endpoints, the contact path, configuration (environment variables), running it locally |
| [Chat contract](docs/chat-contract.md) | `POST /chat`: request, errors, the event stream, signed answers |
| [Guardrails](docs/guardrails.md) | Rate limits, client IP, spend cap, daily quota, the shared store and how it fails |
| [Usage stats](docs/usage-stats.md) | What is recorded, the weekly document, `GET /stats` |
| [Logs and alerts](docs/logs-and-alerts.md) | Log fields, request and alert events, Cloud Monitoring policies |
| [Evals](docs/evals.md) | Eval cases, live runs, replay, pass@k, what CI gates |
| [CI and deployment](docs/deploy.md) | The pipeline, the site and agent deploys, one-time GCP setup, the ranges refresh |
| [Glossary](GLOSSARY.md) | The project's terms |

## Roadmap

Planned work is tracked in [GitHub Issues](https://github.com/acarbonellb/acb-landing-public/issues).
