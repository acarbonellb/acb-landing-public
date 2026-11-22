# Guardrails

What keeps the public [agent](agent.md) from being abused or running up a bill. Rate limits bound each visitor and all of them together, so floods stay cheap; a token budget, a daily quota and a monthly spend cap bound what the model can cost. The table lists each guard; the sections below say how each behaves.

| Guard | Routes | Setting (default) | Kept in | When it refuses |
| --- | --- | --- | --- | --- |
| [Per-IP rate limit](#per-ip-rate-limits) | `/chat`, `/mcp`, `/stats`, each counted separately | `RATE_LIMIT_CHAT_PER_MINUTE` (10), `RATE_LIMIT_MCP_PER_MINUTE` (60), `RATE_LIMIT_STATS_PER_MINUTE` (30) | Instance memory | `429`, per route below |
| [Global ceiling](#global-ceilings) | The same, all clients together | `RATE_LIMIT_CHAT_GLOBAL_PER_MINUTE` (10), `RATE_LIMIT_MCP_GLOBAL_PER_MINUTE` (600), `RATE_LIMIT_STATS_GLOBAL_PER_MINUTE` (300) | Instance memory | Exactly the per-IP limit's `429` |
| [Per-request token cap](#per-request-token-cap) | `/chat` | `AGENT_MAX_REQUEST_TOKENS` (8192) | The request | The request ends with `stopReason: "max_tokens"` |
| [Daily quota](#daily-quota) | `/chat` | `DAILY_SPEND_QUOTA_USD` ($0.10 per key per UTC day) | The store | `429 rate_limited` until midnight UTC |
| [Monthly spend cap](#monthly-spend-cap) | `/chat` | `MONTHLY_SPEND_CAP_USD` ($4 per UTC month) | The store | `503 unavailable` |
| [Provider spend limit](#provider-spend-limit) | The model calls | $5 a month, in the Claude Console | The Anthropic workspace | The stream ends with `unavailable` |

The settings are in the [configuration](agent.md#configuration); each guard sits behind an interface injected through `AppDeps` (`RateLimiter`, `DailyQuota`, `SpendCap`, with an injectable clock), wired in `agent/src/compose.ts`. "The store" is the [shared store](#shared-store) in production and memory elsewhere (`AGENT_STORE`).

## Per-IP rate limits

A fixed one-minute window per route (`agent/src/rate-limit.ts`), counted separately so polling `/stats` never uses up a visitor's `/mcp` (the contact fallback). Over the limit:

| Route | Answer |
| --- | --- |
| `/chat` | The `429 rate_limited` JSON of the [chat contract](chat-contract.md#errors-before-streaming) |
| `/stats` | The same JSON without `retryAfterSeconds`, with `Retry-After` |
| `/mcp` | `429` with `Retry-After` and a JSON-RPC error `{"code":-32000,"data":{"code":"rate_limited","retryAfterSeconds"}}` |

## Global ceilings

A second one-minute window per route counts every request the per-IP limit lets through, under one fixed key, so rotating IPs can't multiply what one source gets. `/chat`'s is sized by what a day-long flood at it costs in store operations ([Store cost](#store-cost)); re-check that section when you raise it. `/stats` answers from a 10 s snapshot and `/mcp` has no store operations of its own, so raising theirs costs no more in the store.

## Rate limits are per instance

The per-IP windows and the global ceilings are counted in the instance's memory (`createMemoryRateLimiter`): they cost no store writes, are exact under any concurrency on one instance, and can't fail. Ended windows are swept once per window length; a cold start starts them afresh.

That is only correct on one instance, so the deploy pins Cloud Run to `--max-instances 1`, and `repo-hygiene/single-instance.test.ts` fails if a workflow deploys or reconfigures the agent without it. During a canary the candidate revision runs beside the serving one with its own windows, so for that minute a key can get up to twice its limit; that is accepted. Why: [ADR 0003, amendment](adr/0003-agent-firestore-over-rest.md#amendment-128-rate-limits-are-per-instance-on-one-instance).

## Client IP

`agent/src/client-ip.ts`: the right-most `X-Forwarded-For` entry, which Cloud Run appends and a caller can't forge. `/chat` and `/stats` are never behind Firebase Hosting and always key on it. Only on `/mcp`, through the site's rewrite, that entry is Hosting's own and the visitor is the entry to its left (measured against the live rewrite: Hosting sends `<visitor>,<hosting>` and drops forged values). So `/mcp` skips the right-most entry only when it is in Google's [user-triggered fetchers ranges](https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json), where that measurement saw Hosting's peer. A caller that can send from those ranges could still choose its key.

A snapshot of the list ships with the agent (`agent/src/google-ranges.json`), with Google's own ranges ([`goog.json`](https://www.gstatic.com/ipranges/goog.json) minus [`cloud.json`](https://www.gstatic.com/ipranges/cloud.json)), used only to count `/mcp` hops that are Google's but not fetchers (`mcp.unknownGoogleHops` in the [usage stats](usage-stats.md#what-is-recorded)), never for keying. A weekly workflow refreshes it ([Ranges refresh](deploy.md#ranges-refresh)); the live check that the keying holds is the [`/mcp` rate-limit check](deploy.md#mcp-rate-limit-check).

## Rate-limit key

The client IP, or its `/64` prefix for IPv6 (`rateLimitKeyFor`), so rotating addresses inside one network's block doesn't buy a fresh window; clients sharing a `/64` share a limit. IPv4 addresses, IPv4-mapped ones included, are keyed whole.

## Per-request token cap

One output-token budget (`AGENT_MAX_REQUEST_TOKENS`) shared by all the model calls of a request; when it runs out the request ends with `stopReason: "max_tokens"`.

## Monthly spend cap

`agent/src/spend-cap.ts`: before calling the model, each chat request reserves its worst-case cost (its whole output budget plus a generous input estimate) and is refused with `503 unavailable` if that doesn't fit in what's left of `MONTHLY_SPEND_CAP_USD` this UTC month, so concurrent requests can't overshoot together. MCP tools cost nothing and keep working. The chat shows the visitor the date it reopens (`resetsAt`).

The request's actual `usage` is added up in memory while it runs and charged once, when it settles, in place of the reservation: no store write between model calls. A call cut off because the visitor left is still charged, conservatively, at its output cap plus its input, and the request's handler resolves only once that charge and the settle are in the store (`waitUntil` in `agent/src/server.ts`).

Whether Cloud Run keeps the CPU allocated for that work after the visitor disconnected isn't documented. Its docs say only that with request-based billing "CPU is allocated when instances are processing requests" ([container contract](https://docs.cloud.google.com/run/docs/container-contract)) and that "background activity is anything that happens after your HTTP response has been delivered" ([general tips](https://docs.cloud.google.com/run/docs/tips/general)), not whether a request whose client has left still counts as processing (read on 2026-11-22). So the drain may be throttled or stopped. The safety net is the reservation's expiry: an unsettled hold is charged at its worst case ([below](#when-a-reservation-is-released)), so spend is never under-counted.

## Daily quota

`agent/src/daily-quota.ts`: each rate-limit key may spend `DAILY_SPEND_QUOTA_USD` of estimated model cost per UTC day on `/chat`, so a few sources can't spend the month's cap in minutes. It counts spend, not requests, with the same reservation as the spend cap, taken first, so a long conversation counts for what it may cost. One that doesn't fit is refused like a rate limit: `429 rate_limited` with `Retry-After`, `retryAfterSeconds` and `resetsAt` (midnight UTC); the chat shows when the visitor can ask again.

The default ($0.10) comes from `/stats`: about $0.0004 per answer measured in week 45, so some 250 short answers or a few dozen long ones, far beyond a real visitor, and still above a maximal request's worst case (about $0.02 on Claude Haiku 5.5; a short question reserves about $0.01). Forty keys a day are needed to spend the $4 cap.

### When a reservation is released

Settling a reservation replaces its hold with what the request actually spent (nothing, for a request that never ran; `agent/src/app.ts`, `agent/src/spend-holds.ts`):

- **The quota refuses** (`429`): nothing was reserved, so nothing is held.
- **The spend cap refuses** (`503`, `httpErrorMessages.spendCap`): the quota's reservation is settled before the answer.
- **The spend cap's reservation throws** (a store error): the quota's reservation is settled, then the route answers `503 unavailable` ([When the store fails](#when-the-store-fails)), so a store error doesn't hold the visitor's quota.
- **The quota's reservation throws**: no reservation was taken; the request answers `503 unavailable`. A hold the store wrote before failing (a commit whose reply timed out) is never settled, so it expires like the next bullet's.
- **The chat runs**: both reservations are settled once the run ends, however it ends (answered, failed, or the visitor left).
- **Settling fails, or never happens** (the store failed, logged as `store_error`, or the instance died or was throttled mid-request): the hold stays until it expires, 15 minutes after the request arrived (Cloud Run's request timeout is 5), and is then charged at its worst case, not released: what the request spent was only in its instance's memory, so the worst case is the one figure that never under-counts. A settle that still arrives later charges only what it spent beyond that worst case.

An expired hold is charged by the **next reservation on the same document**. The month's spend document and a key's daily document get none once their period is over, so their last expired holds never reach `spentUsd`, and a threshold alert that charge would have crossed never fires. Enforcement is unaffected: until it is charged, an expired hold still counts against the limit, and a new period starts a new document. What is lost is bookkeeping of a closed period: a few worst cases at most (about $0.02 each), in its recorded total and its alerts.

## Provider spend limit

The Anthropic workspace has its own hard limit of $5 per month, set in the Claude Console. The code cap defaults to $4, below it, because the code cap only estimates spend (list prices from `agent/src/pricing.ts`) and is the one with a graceful answer: it refuses before calling the model and says when the chat reopens. Raise both together, keeping the code cap under the provider's.

If the provider limit is hit (a 400 naming the usage limit, or a 402 `billing_error` when there is no credit), `agent/src/anthropic.ts` treats it like an outage: the stream ends with `unavailable`, not `internal`, and the `provider_limit` [alert event](logs-and-alerts.md#alert-events) is logged, since it means the two have drifted apart.

## Store cost

The model's cost is bounded by the [spend cap](#monthly-spend-cap) whatever the traffic; the store's isn't, so the `/chat` and `/stats` ceilings are sized by it.

### Store operations per request

Every store change reads the document, then commits it (`agent/src/firestore.ts`), so each write comes with a read; a commit that conflicts is re-read and retried ([load test](#load-test)).

| Request | Writes | Reads | What they are |
| --- | --- | --- | --- |
| `/chat` that runs | 4 | 4 | Daily quota and spend cap, each once to reserve and once to settle, whatever the number of model calls; its usage joins the next batch. Checked: `agent/src/spend-writes-http.test.ts` |
| `/chat` refused by the spend cap (`503`) | 2 | 3 | The daily quota's reserve and settle; the spend cap's refused reservation is a read only |
| `/chat` refused by the daily quota (`429`) | 0 | 1 | The quota's refused reservation |
| `/chat` refused by a rate limit or ceiling, invalid (`400`, `413`), or with no model (`503`); `/mcp` | 0 | 0 | Counted in the next usage batch, if at all |
| Usage batch | 1 | 1 | Every chat and MCP request counted since the last batch, written inside the first request that records usage 10 s after the last batch, so at most 8,640 a day ([Usage stats](usage-stats.md#batching)). Once a week per instance it also reads the previous week's document |
| `/stats` within 10 s of its last read | 0 | 0 | Answered from the in-memory snapshot ([`GET /stats`](usage-stats.md#get-stats)) |
| `/stats` that finds its snapshot stale | 0 or 1 | 2 or 3 | It writes the waiting batch first, if one is waiting, then reads this week's and last week's documents; calls arriving meanwhile share that read. At most one every 10 s, so at most 8,640 a day whatever the ceiling. A failed read isn't kept, so while the store fails each call let through tries again |
| `/health?deep=1` | 0 | 1 | One read, under its own ceiling of 10 a minute ([health check](chat-contract.md#health-check)) |

Each daily-quota document (one per key and UTC day) is removed by Firestore's TTL policy, one TTL delete each.

### A day-long flood at the ceilings

Computed with Firestore Standard edition's prices in `europe-southwest1` (Madrid), from Google Cloud's [Firestore pricing](https://cloud.google.com/firestore/pricing) page, read on 2026-11-22: **$0.035 per 100,000 document reads, $0.106 per 100,000 writes, $0.012 per 100,000 TTL deletes**. Every request the ceiling lets through takes its row's most expensive path (every chat request runs, on a fresh key; every stale `/stats` snapshot finds a batch waiting). The free tier (50,000 reads and 20,000 writes a day) is ignored: it takes off at most about $0.04 a day, and a flood writes three times what it covers. Storage is negligible.

| Ceiling (default) | Requests a day | Writes | Reads | TTL deletes | Cost a day |
| --- | --- | --- | --- | --- | --- |
| `/chat`, 10 a minute | 14,400 | 57,600 | 57,600 | 14,400 | $0.083 |
| `/stats`, 300 a minute | 432,000, of which 8,640 reach the store | 8,640 | 25,920 | 0 | $0.018 |
| `/mcp`, 600 a minute | 864,000 | 0 | 0 | 0 | $0.000 |
| Usage batches, one per 10 s | 8,640 | 8,640 | 8,640 | 0 | $0.012 |
| `/health?deep=1`, 10 a minute | 14,400 | 0 | 14,400 | 0 | $0.005 |
| **All together** | | **74,880** | **106,560** | **14,400** | **$0.118** |

**The threshold: a day-long flood at every default ceiling at once costs less than $0.12 a day in store operations**, so a month of it (about $3.55) stays under the month's model budget (the $4 spend cap). `agent/src/config.test.ts` computes this from the defaults and fails if a change crosses it. Not counted: Cloud Run's own cost and network egress.

`/stats` is read on every page load. Its 10 s snapshot (`agent/src/usage.ts`) lets at most one call per 10 s reach the store, so it costs about $0.018 a day whatever its ceiling; read on every call, it cost about $0.001 a day per request a minute of ceiling, which held the ceiling at 11 (some 660 page loads an hour, against some 18,000 at 300).

The room left goes to `/chat`, at 10 a minute: 11 would cost about $0.127 a day. At the older ceilings (60 chat and 300 `/stats` a minute, `/stats` read on every call) the same flood cost about $1.55 a day. `/mcp` keeps 600: it costs no store operations of its own.

## Load test

What the [load test](development.md#the-load-test-on-the-firestore-emulator) measured, flooding each route at twice its ceiling against the Firestore emulator. "At most" is the limit times the one-minute windows between the first request and the last answer.

**Latest result:** commit `5eee005` (2026-11-22), default configuration (ceilings `/chat` 10, `/mcp` 600, `/stats` 300 a minute; per key 10, 60, 30), 120 s per shape, 4,040 requests per shape.

| Shape | Endpoint | Requests | Answered | Refused (`rate_limited`) | Errors | Let through (at most) | One key: let through (at most) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| steady | `/chat` | 80 | 20 | 60 | 0 | 20 (20) | 10 of 40 (20) |
| steady | `/mcp` | 2,640 | 1,200 | 1,440 | 0 | 1,200 (1,200) | 109 of 240 (120) |
| steady | `/stats` | 1,320 | 600 | 720 | 0 | 600 (600) | 55 of 120 (60) |
| burst | `/chat` | 80 | 10 | 70 | 0 | 10 (20) | 0 of 40 (20) |
| burst | `/mcp` | 2,640 | 1,200 | 1,440 | 0 | 1,200 (1,200) | 0 of 240 (120) |
| burst | `/stats` | 1,320 | 600 | 720 | 0 | 600 (600) | 57 of 120 (60) |

| Shape | Store writes | Reads | Conflicts (all retried) | Other store failures |
| --- | --- | --- | --- | --- |
| steady | 94 (`dailySpend` 40, `spend` 40, `usage` 14) | 120 | 12 (`spend` 11, `usage` 1) | 0 |
| burst | 44 (`dailySpend` 20, `spend` 20, `usage` 4) | 72 | 22 (`spend` 22) | 0 |

No limit let through more than its limit, and every answered chat request ran to `done`. Writes match [the table above](#store-operations-per-request). `/stats` answered 600 calls in each shape but reached the store only when its snapshot was stale: the steady shape wrote 14 `usage` batches in 120 s, under the two per 10 s that usage and stale snapshots can write together, and read the store 120 times in all, against 144 in the previous run for 22 `/stats` calls at the old ceiling of 11.

Concurrent chat requests race on the month's `spend` document, and every conflict was retried well inside the 10 tries an update gets. In the burst `/chat`'s second minute was refused because its window opened a few milliseconds after the first burst: the window being strict, not a failure.

## Shared store

With `AGENT_STORE=firestore` the durable state (spend cap, daily quota, usage stats) lives in Firestore, so it survives cold starts and is shared by every revision. The agent talks to Firestore's REST API with plain `fetch` and the service account's token from the metadata server ([ADR 0003](adr/0003-agent-firestore-over-rest.md)). Creating the database: [Deploy](deploy.md#the-firestore-database); the emulator: [Agent service](agent.md#running-it-locally).

| Document | Holds |
| --- | --- |
| `spend/<YYYY-MM>`, one per UTC month | `spentUsd`, the running requests' `holds` (each reservation's worst case and `expireAt`), and `alerted`, the alert events already fired this month ([Logs and alerts](logs-and-alerts.md#alert-events)) |
| `dailySpend/<YYYY-MM-DD>:<key>` (URL-encoded), one per key and UTC day | The same, plus `expireAt`, the day's end, for the TTL policy |
| `usage/<YYYY-Www>`, one per ISO week | The week's aggregates ([Usage stats](usage-stats.md#the-weekly-document)) |

Every change is read, then committed with a precondition on the document's `updateTime` (or that it doesn't exist yet); if another request wrote in between, it is re-read and re-applied, so parallel requests can't both fit under the same remaining room.

With `AGENT_STORE=memory` the same state is per instance and resets on every cold start, so in production (`NODE_ENV=production`, set in `agent/Dockerfile`) the agent refuses to start with it unless `AGENT_ALLOW_MEMORY_STORE=true`; the deploy never sets that.

### When the store fails

Every Firestore REST call (and the metadata server's token request) gives up after 3 s. Each route then follows its own policy (`agent/src/app.ts`):

| Route | When the store fails |
| --- | --- |
| `/mcp` | Reads nothing from the store, so `get_contact` keeps answering and the limits keep holding. It is the contact fallback when the chat is down |
| `/stats` | Answers `503 unavailable` JSON if the aggregates can't be read; the page then hides its usage line |
| `/chat` | **Fails closed**: a failed reservation answers `503 unavailable` JSON (`errorMessages.unavailable`), so the chat never starts without one ([When a reservation is released](#when-a-reservation-is-released)). The page falls back to `/mcp` for the contact |

Any other error a route doesn't handle reaches the app's error handler, which answers `503` in the route's contract (JSON on `/chat` and `/stats`, a JSON-RPC error `-32603` with `data.code: "unavailable"` on `/mcp`), never a plain-text `500`; the CORS headers stay on. Recording usage stats is best effort everywhere. Errors are logged with the collection only (`spend`, `dailySpend`, `usage`), never the document id, which can hold a client IP, nor Firestore's response body.
