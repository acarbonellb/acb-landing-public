# Guardrails

What keeps the public [agent](agent.md) from being abused or running up a bill. The limits are set through the [configuration](agent.md#configuration). They sit behind interfaces injected through `AppDeps` (`RateLimiter`, `DailyQuota`, `SpendCap`, with an injectable clock). The rate limits are always in memory, in production too (see [Rate limits are per instance](#rate-limits-are-per-instance)). The **durable state**, the daily quota, the spend cap and the usage stats, has two implementations: in memory (local development and tests) and over a shared document store (production, see [Shared store](#shared-store)). `AGENT_STORE` picks one, in the production composer (`agent/src/compose.ts`).

## Per-IP rate limits

On `/chat`, `/mcp` and `/stats`, each counted separately (`agent/src/rate-limit.ts`, fixed one-minute window), so polling `/stats` never uses up a visitor's `/mcp` (the contact fallback). Over the limit, `/chat` answers the `429 rate_limited` JSON of the [chat contract](chat-contract.md#errors-before-streaming), `/stats` the same JSON without `retryAfterSeconds` (with `Retry-After`), and `/mcp` answers `429` with `Retry-After` and a JSON-RPC error `{"code":-32000,"data":{"code":"rate_limited","retryAfterSeconds"}}`.

## Global ceilings

On `/chat` (`RATE_LIMIT_CHAT_GLOBAL_PER_MINUTE`), `/mcp` (`RATE_LIMIT_MCP_GLOBAL_PER_MINUTE`) and `/stats` (`RATE_LIMIT_STATS_GLOBAL_PER_MINUTE`): a second one-minute window per endpoint that counts every request the per-IP limit lets through, under one fixed key. So rotating IPs can't multiply what one source gets: past the ceiling the model is never called more often, whoever asks. A refusal answers exactly the per-IP limit's `429`. The defaults sit above the per-IP limits and far above normal traffic, and `/chat`'s and `/stats`'s are sized by what a flood at them costs in store operations ([Store cost](#store-cost)); tune them from `/stats` through the configuration, and re-check that section when you raise one.

## Rate limits are per instance

The per-IP windows and the global ceilings are counted in the instance's memory (`createMemoryRateLimiter`), never in the store: they cost no store writes, are exact under any concurrency on one instance, and can't fail, so no route has a store-failure policy for them. That is only correct on one instance, so the deploy pins Cloud Run to `--max-instances 1` and a repo-hygiene test (`repo-hygiene/single-instance.test.ts`) fails if a workflow deploys or reconfigures the agent without it. During a canary the candidate revision runs beside the serving one, each with its own windows, so for that minute a key can get up to twice its limit; that overlap is accepted. A cold start starts the windows afresh. Why: [ADR 0003, amendment](adr/0003-agent-firestore-over-rest.md#amendment-128-rate-limits-are-per-instance-on-one-instance). Memory stays bounded: ended windows are swept once per window length.

## Client IP

`agent/src/client-ip.ts`: the right-most `X-Forwarded-For` entry, which Cloud Run appends and a caller can't forge. `/chat` and `/stats` are never behind Firebase Hosting and always key on it. Only on `/mcp`, through the site's rewrite, that entry is Hosting's own and the visitor is the entry to its left (measured against the live rewrite: Hosting sends `<visitor>,<hosting>` and drops forged values). So `/mcp` skips the right-most entry only when it is in Google's [user-triggered fetchers ranges](https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json), where that measurement saw Hosting's peer. A caller that can send from those ranges could still choose its key.

A snapshot of the list ships with the agent (`agent/src/google-ranges.json`), with Google's own ranges ([`goog.json`](https://www.gstatic.com/ipranges/goog.json) minus [`cloud.json`](https://www.gstatic.com/ipranges/cloud.json)), used only to count `/mcp` hops that are Google's but not fetchers (`mcp.unknownGoogleHops` in the [usage stats](usage-stats.md#what-is-recorded), the sign the snapshot is stale), never for keying. Refresh all three with `pnpm agent:ranges` and commit the result; a weekly workflow does it and opens a PR ([Ranges refresh](deploy.md#ranges-refresh)). The live check that the keying holds is the [`/mcp` rate-limit check](deploy.md#mcp-rate-limit-check).

## Rate-limit key

The client IP, or its `/64` prefix for IPv6 (`rateLimitKeyFor`), so rotating addresses inside one network's block doesn't buy a fresh window; clients sharing a `/64` share a limit. IPv4 addresses, IPv4-mapped ones included, are keyed whole.

## Per-request token cap

One output-token budget (`AGENT_MAX_REQUEST_TOKENS`) shared by all the model calls of a request; when it runs out the request ends with `stopReason: "max_tokens"`.

## Monthly spend cap

`agent/src/spend-cap.ts`: before calling the model, each chat request reserves its worst-case cost (its whole output budget plus a generous input estimate) and is refused with `503 unavailable` if that doesn't fit in what's left of `MONTHLY_SPEND_CAP_USD` this UTC month, so concurrent requests can't overshoot together. The actual `usage` of its model calls is added up in memory while it runs, and charged once, when the request settles, in place of the reservation: no store write happens between model calls. A call cut off because the visitor left is still charged, conservatively, at its output cap plus its input. That charge and the settle happen inside the request: its handler resolves only once they are in the store (`waitUntil` in `agent/src/server.ts`), so nothing waits for CPU after the response. MCP tools cost nothing and keep working. The chat shows the visitor the date it reopens (`resetsAt`).

## Daily quota

`agent/src/daily-quota.ts`: each rate-limit key may spend `DAILY_SPEND_QUOTA_USD` of estimated model cost per UTC day on `/chat`, so a few sources can't spend the month's cap in minutes. It counts spend, not requests, with the same reservation as the spend cap: each chat request reserves its worst case against the key's quota first, then against the spend cap, so a long conversation counts for what it may cost. One that doesn't fit is refused like a rate limit: `429 rate_limited` with `Retry-After` and `retryAfterSeconds` until midnight UTC, plus `resetsAt`; the chat shows when the visitor can ask again.

### When a reservation is released

A chat request holds a reservation against the daily quota and then the spend cap (`agent/src/app.ts`, `agent/src/spend-holds.ts`). Settling a reservation replaces its hold with what the request actually spent (nothing, for a request that never ran):

- **The quota refuses** (`429`): nothing was reserved, so nothing is held.
- **The spend cap refuses** (`503`, `httpErrorMessages.spendCap`): the quota's reservation is settled before the answer.
- **The spend cap's reservation throws** (a store error): the quota's reservation is settled, then the store-failure policy answers `503 unavailable` (see [When the store fails](#when-the-store-fails)), so a store error doesn't hold the visitor's quota.
- **The quota's reservation throws**: no reservation was taken; the request answers `503 unavailable`. A hold the store wrote before failing (a commit whose reply timed out) is never settled, so it expires and is charged like the next bullet's.
- **The chat runs**: both reservations are settled once the run ends, however it ends (answered, failed, or the visitor left).
- **Settling fails, or never happens** (the store failed, or the instance died mid-request): that reservation stays until it expires, 15 minutes after the request arrived, and is then charged at its worst case, not released. What the request actually spent was only in its instance's memory, so the worst case is the one figure that never under-counts. The next reservation on that document charges it. A settle that still arrives later charges only what it spent beyond that worst case.

The default ($0.10) comes from `/stats`: about $0.0004 per answer measured in week 45, so $0.10 is some 250 short answers or a few dozen long ones, far beyond a real visitor, and still above a maximal request's worst case (about $0.02 on Claude Haiku 5.5; a short question reserves about $0.01). Forty keys a day are needed to spend the $4 cap.

## Provider spend limit

The Anthropic workspace has its own hard limit of $5 per month, set in the Claude Console: the spend cap counts estimated spend, so that is the hard limit. The code cap defaults to $4, below it, because the code cap only estimates spend (list prices from `agent/src/pricing.ts`, at the requested model's rates) and is the one with a graceful answer: it refuses before calling the model and says when the chat reopens. The provider limit is the backstop if the estimate is ever off; if it is hit (a 400 naming the usage limit, or a 402 `billing_error` when there is no credit), `agent/src/anthropic.ts` treats it like an outage and the stream ends with `unavailable`, not `internal`. Raise both together, keeping the code cap under the provider's. Hitting the provider limit logs the `provider_limit` [alert event](logs-and-alerts.md#alert-events), since it means the two have drifted apart.


## Store cost

What the [shared store](#shared-store) costs per request, and per day at the [global ceilings](#global-ceilings). The model's cost is bounded by the [spend cap](#monthly-spend-cap) whatever the traffic; the store's isn't, so the `/chat` and `/stats` ceilings are sized by it.

### Store operations per request

Every store change reads the document, then commits it (`agent/src/firestore.ts`), so each write comes with a read. A commit that conflicts is re-read and retried, a read and a write attempt more. Even on one instance (see [Rate limits are per instance](#rate-limits-are-per-instance)) chat requests that run at the same time race on the month's `spend` document and the week's `usage` document, so a few conflicts are normal; the [load test](#load-test) measures them.

| Request | Writes | Reads | What they are |
| --- | --- | --- | --- |
| `/chat` that runs | 5 | 5 | Daily quota and spend cap, each once to reserve and once to settle, whatever the number of model calls, and the request's usage record. Checked: `agent/src/spend-writes-http.test.ts`. Once a week per instance it also reads the previous week's usage document |
| `/chat` refused by the spend cap (`503`) | 2 | 3 | The daily quota's reserve and settle; the spend cap's refused reservation is a read only |
| `/chat` refused by the daily quota (`429`) | 0 | 1 | The quota's refused reservation |
| `/chat` refused by a rate limit or ceiling, invalid (`400`, `413`), or with no model (`503`) | 0 | 0 | Rate limits are in memory; refusals are counted in the next usage batch |
| `/mcp` | 0 | 0 | Counted in the next usage batch. Checked: `agent/src/spend-writes-http.test.ts` |
| Usage batch | 1 | 1 | MCP requests and chat refusals since the last batch, written inside the first request that records usage 10 s after the last one, so at most 8,640 a day ([Usage stats](usage-stats.md#batching)); a fresh instance's first is due at once |
| `/stats` | 1 | 3 | It writes the waiting batch first, whether due or not (nothing if none is waiting), then reads this week's and last week's documents |
| `/health?deep=1` | 0 | 1 | One read, under its own ceiling of 10 a minute (`agent/src/health.ts`) |

Each daily-quota document (one per key and UTC day) is removed by Firestore's TTL policy, one TTL delete each.

### A day-long flood at the ceilings

Computed with Firestore Standard edition's prices for the database's location, `europe-southwest1` (Madrid), as listed on Google Cloud's [Firestore pricing](https://cloud.google.com/firestore/pricing) page, read on 2026-11-22: **$0.035 per 100,000 document reads, $0.106 per 100,000 writes, $0.012 per 100,000 TTL deletes**. The worst case assumes every request the ceiling lets through takes its row's most expensive path (every chat request runs, on a fresh key, and every `/stats` call finds a batch waiting), and ignores the free tier (50,000 reads and 20,000 writes a day, on the project's one free database), which takes off at most about $0.04 a day. Storage is negligible: the daily-quota documents are deleted each day.

| Ceiling (default) | Requests a day | Writes | Reads | TTL deletes | Cost a day |
| --- | --- | --- | --- | --- | --- |
| `/chat`, 8 a minute | 11,520 | 57,600 | 57,600 | 11,520 | $0.083 |
| `/stats`, 5 a minute | 7,200 | 7,200 | 21,600 | 0 | $0.015 |
| `/mcp`, 600 a minute | 864,000 | 0 | 0 | 0 | $0.000 |
| Usage batches, one per 10 s | 8,640 | 8,640 | 8,640 | 0 | $0.012 |
| `/health?deep=1`, 10 a minute | 14,400 | 0 | 14,400 | 0 | $0.005 |
| **All together** | | **73,440** | **102,240** | **11,520** | **$0.115** |

**The threshold: a day-long flood at every default ceiling at once costs less than $0.12 a day in store operations**, so a month of it (about $3.45) stays under the month's model budget (the $4 spend cap). `agent/src/config.test.ts` computes this from the default ceilings and fails if a change to them crosses it. A flood writes more than three times the free tier's 20,000 writes a day, so the free tier doesn't cover it.

The ceilings were re-derived for this: before, at 60 chat and 300 `/stats` requests a minute, the same flood cost about $1.55 a day (some $46 a month, over ten times the model budget). Now `/chat` allows 8 a minute from all clients (4 per IP) and `/stats` 5 (2 per IP): still far above a personal site's traffic, and a page reads `/stats` once per load and caches it 5 minutes. `/mcp` keeps 600 a minute: it costs no store operations of its own. Not counted here: Cloud Run's own cost and network egress.

## Load test

`pnpm agent:load-test` floods `/chat`, `/mcp` and `/stats` at twice each ceiling, locally, against the Firestore emulator with a fake model (no model call); how to run it is in [Development](development.md#the-load-test-on-the-firestore-emulator). "At most" is what a one-minute fixed window can let through over the run: the limit times the windows that fit between the first request and the last answer.

**Latest result:** commit `8c92766` (2026-11-22), default configuration (ceilings `/chat` 8, `/mcp` 600, `/stats` 5 a minute; per key 4, 60, 2), 120 s per shape, 2,716 requests per shape.

| Shape | Endpoint | Requests | Answered | Refused (`rate_limited`) | Errors | Let through (at most) | One key: let through (at most) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| steady | `/chat` | 48 | 16 | 32 | 0 | 16 (16) | 5 of 16 (8) |
| steady | `/mcp` | 2,640 | 1,200 | 1,440 | 0 | 1,200 (1,200) | 109 of 240 (120) |
| steady | `/stats` | 28 | 10 | 18 | 0 | 10 (10) | 3 of 8 (4) |
| burst | `/chat` | 48 | 8 | 40 | 0 | 8 (16) | 0 of 16 (8) |
| burst | `/mcp` | 2,640 | 1,200 | 1,440 | 0 | 1,200 (1,200) | 0 of 240 (120) |
| burst | `/stats` | 28 | 10 | 18 | 0 | 10 (10) | 3 of 8 (4) |

| Shape | Store writes | Reads | Conflicts (all retried) | Other store failures |
| --- | --- | --- | --- | --- |
| steady | 96 (`dailySpend` 32, `spend` 32, `usage` 32) | 124 | 6 (`spend` 5, `usage` 1) | 0 |
| burst | 44 (`dailySpend` 16, `spend` 16, `usage` 12) | 77 | 11 (`spend` 11) | 0 |

- **No limit let through more than its limit**, per key or global, in either shape. No refusal by the daily quota or the spend cap, and no error: every answered chat request ran to `done`.
- **Writes match [the table above](#store-operations-per-request)**: each chat request that ran wrote its daily quota and the spend cap twice each; the rest are usage records and batches.
- **Conflicts are real on one instance**: concurrent chat requests race on the month's `spend` document (11 conflicts for 8 simultaneous requests in the burst), and every one was retried and landed, well inside the 10 tries an update gets.
- In the burst, `/chat`'s second minute was refused: its window opened when the first burst arrived, a few milliseconds after the start, so the second burst, sent exactly 60 s later, still fell inside it. That is the window being strict, not a failure.

## In memory

With `AGENT_STORE=memory`, the durable state (cap, daily quota, usage stats) is per instance and resets on every cold start. So in production (`NODE_ENV=production`, set in `agent/Dockerfile`) the agent refuses to start with `AGENT_STORE=memory` and says why, unless `AGENT_ALLOW_MEMORY_STORE=true` accepts it explicitly; the deploy never sets that. The agent is deployed with Cloud Run `--max-instances 1` either way, as the rate limits need it ([above](#rate-limits-are-per-instance)).

## Shared store

With `AGENT_STORE=firestore` the durable state, the spend cap, the daily quota and the usage stats, lives in Firestore, so it survives cold starts and is shared by every revision: the month's spend no longer starts again at $0 when the service scales to zero. The agent talks to Firestore's REST API with plain `fetch` and the service account's token from the metadata server, so the bundle stays self-contained ([ADR 0003](adr/0003-agent-firestore-over-rest.md)). Creating the database is a one-time step in [Deploy](deploy.md#the-firestore-database); trying it locally against the emulator is in [Agent service](agent.md#running-it-locally).

- **Spend**: one document per UTC month, `spend/<YYYY-MM>`, holding `spentUsd`, the `holds` of the requests running (each reservation's worst case and `expireAt`) and `alerted`, the alert events already fired this month (see [Logs and alerts](logs-and-alerts.md#alert-events)). A reservation never settled (its instance died) is charged at its worst case after 15 minutes (Cloud Run's request timeout is 5); see [When a reservation is released](#when-a-reservation-is-released).
- **Daily quota**: one document per rate-limit key and UTC day, `dailySpend/<YYYY-MM-DD>:<key>` (URL-encoded), shaped like the monthly spend document, with `expireAt`, the day's end, for the TTL policy.
- **Usage**: one document per ISO week, `usage/<YYYY-Www>`, with the week's aggregates (see [Usage stats](usage-stats.md#the-weekly-document)).
- **Concurrency**: every change is read, then committed with a precondition on the document's `updateTime` (or that it doesn't exist yet); if another request wrote in between, it is re-read and re-applied. So parallel requests can't both pass the limit or both fit under the same remaining room of a spend limit.
- **Cost**: what each request costs in store operations, and what a flood at the ceilings costs a day, is in [Store cost](#store-cost).

### When the store fails

Every Firestore REST call (and the metadata server's token request) gives up after 3 s, so a hanging store fails fast instead of holding the request. Each route then follows its own policy (`agent/src/app.ts`):

- `/mcp` reads nothing from the store (its rate limits are in memory), so `get_contact` keeps answering and the limits keep holding. It is the contact fallback when the chat is down.
- `/stats` keeps its rate limits too, and answers `503 unavailable` JSON if the aggregates can't be read; the page then hides its usage line.
- `/chat` **fails closed**: a failed reservation (daily quota or spend cap) answers `503 unavailable` JSON (`errorMessages.unavailable`), so the chat never starts without a reservation; a quota reservation already taken is released first ([When a reservation is released](#when-a-reservation-is-released)). The page falls back to `/mcp` for the contact.
- Any other error a route doesn't handle reaches the app's error handler, which answers in the route's contract (JSON on `/chat` and `/stats`, a JSON-RPC error `-32603` with `data.code: "unavailable"` on `/mcp`, both `503`), never a plain-text `500`; the CORS headers stay on.
- If settling fails once the answer has streamed, the error is logged and the request's reservation stays until it expires, then is charged at its worst case, covering whatever the request spent. Recording usage stats is best effort everywhere.
- Errors are logged with the collection only (`spend`, `dailySpend`, `usage`), never the document id, which can hold a client IP, nor Firestore's response body.
