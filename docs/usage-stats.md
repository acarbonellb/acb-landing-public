# Usage stats

The [agent](agent.md) keeps weekly aggregates of its own traffic (`agent/src/usage.ts`) and serves them publicly; the page reads them in the browser and shows one line under the chat, e.g. `// this week: 24 questions answered · p50 2 s · 4% errors · $0.03` (last week's figures until this week has an answer; no line at all if `/stats` fails or nothing was answered).

## What is recorded

Each chat request, once it ends, is folded into its ISO week's document: the request, its outcome, its tokens (all model calls, estimated ones included), its estimated cost (the model's list prices, `agent/src/pricing.ts`) and two latencies, from arrival to the end of the stream and to the first text, as counts in fixed histogram buckets (250 ms … 5 min, plus an unbounded one). Outcomes (`ChatOutcome` in [`src/shared/stats-contract.ts`](../src/shared/stats-contract.ts)) are the stream's `stopReason`, `error:<code>` for a stream `error`, `aborted` when the visitor left mid-answer, and `http_429` / `http_503` for refusals before streaming (no latency for those). Malformed requests (400, 413) aren't recorded.

Each MCP HTTP request served is counted, nothing more (a client's session is several: initialize, list, calls), and the answer doesn't wait for that write; `/stats` itself isn't counted. `mcp.unknownGoogleHops` counts `/mcp` requests, refused ones included, whose right-most `X-Forwarded-For` hop is a Google address (in `goog.json`, not in `cloud.json`) outside the user-triggered fetchers ranges: where Hosting's peer would show up if it moved outside the snapshot, so its visitors share one rate-limit key (see [Client IP](guardrails.md#client-ip)). Google Cloud's ranges (`cloud.json`) are left out on purpose, as #36 defined the count: any Google Cloud customer can send from them, so counting them would be noise, not a sign of Hosting moving. It should stay at 0; if it doesn't, refresh the snapshot.

The address itself is never kept. **No message content and no IPs** are ever recorded. Recording is best effort: a failure is logged and the request goes on.

## Batching

Refusals before streaming (`http_429`, `http_503`) and `unknownGoogleHops` aren't written one by one: each instance counts them in memory and folds them into the week's document in one write every 10 seconds, before answering `/stats`, and on shutdown (`SIGTERM`). A batch that fails to write is logged and kept for the next one. So a flood the guardrails already refuse costs one write per batch, not one per request; `/stats` still counts each refusal once its batch is written (another instance's latest batch may be up to 10 seconds behind).

## The weekly document

`usage/<YYYY-Www>` (e.g. `usage/2026-W45`, ISO weeks from Monday 00:00 UTC), in the same store as the guardrails (`AGENT_STORE`, see [Shared store](guardrails.md#shared-store); in memory it is per instance and lost on restart):

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
  "mcp": { "requests": 12, "unknownGoogleHops": 0 },
  "errorWindow": { "1793872800000": { "streamed": 3, "errors": 0 } },
  "alerted": { "chat_error_rate": false }
}
```

Histogram keys are bucket upper bounds in ms (`inf` past the last). `errorWindow` and `alerted` serve the `chat_error_rate` [alert event](logs-and-alerts.md#alert-events): streamed requests and errors per 10-minute bucket (keyed by its start, ms since epoch), pruned past the hour, and whether the alert is in effect; `errorWindow` is absent until the week's first streamed request, which copies the previous week's last hour into it. `/stats` doesn't serve them.

## `GET /stats`

Answers this week's and the previous week's aggregates, any origin (CORS `*`), `Cache-Control: public, max-age=300`, under its own [per-IP limit and global ceiling](guardrails.md#per-ip-rate-limits) (`RATE_LIMIT_STATS_PER_MINUTE`, `RATE_LIMIT_STATS_GLOBAL_PER_MINUTE`); `503 unavailable` if the store can't be read. The body is `StatsResponse` in [`src/shared/stats-contract.ts`](../src/shared/stats-contract.ts), which documents each field (`answered`, `errorRate`, the latency percentiles).

## Cost

One more Firestore write per chat request that streams and per MCP request, one per batch of refusals (at most one per instance every 10 seconds, plus one before each `/stats` read when a batch is waiting), and two document reads per `/stats` call (cached by browsers for 5 minutes). Every chat and MCP request in a week writes the same document; at this site's traffic that is far below Firestore's limit of about one sustained write per second per document, and a conflict only retries. One small document a week accumulates; no TTL is needed.
