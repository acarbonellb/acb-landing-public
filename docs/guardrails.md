# Guardrails

What keeps the public [agent](agent.md) from being abused or running up a bill. The limits are set through the [configuration](agent.md#configuration). They sit behind interfaces injected through `AppDeps` (`RateLimiter`, `DailyQuota`, `SpendCap`, with an injectable clock), each with two implementations: in memory (local development and tests) and over a shared document store (production, see [Shared store](#shared-store)). `AGENT_STORE` picks one, in the production composer (`agent/src/compose.ts`).

## Per-IP rate limits

On `/chat`, `/mcp` and `/stats`, each counted separately (`agent/src/rate-limit.ts`, fixed one-minute window), so polling `/stats` never uses up a visitor's `/mcp` (the contact fallback). Over the limit, `/chat` answers the `429 rate_limited` JSON of the [chat contract](chat-contract.md#errors-before-streaming), `/stats` the same JSON without `retryAfterSeconds` (with `Retry-After`), and `/mcp` answers `429` with `Retry-After` and a JSON-RPC error `{"code":-32000,"data":{"code":"rate_limited","retryAfterSeconds"}}`.

## Global ceilings

On `/chat` (`RATE_LIMIT_CHAT_GLOBAL_PER_MINUTE`), `/mcp` (`RATE_LIMIT_MCP_GLOBAL_PER_MINUTE`) and `/stats` (`RATE_LIMIT_STATS_GLOBAL_PER_MINUTE`): a second one-minute window per endpoint that counts every request the per-IP limit lets through, under one fixed key. So rotating IPs can't multiply what one source gets: past the ceiling the model is never called more often, whoever asks. A refusal answers exactly the per-IP limit's `429`. The defaults are set well above the per-IP limits and normal traffic; tune them from `/stats` through the configuration.

## Local refusal cache

`withRefusalCache` in `agent/src/rate-limit.ts`, with the shared store only: once the store refuses a key (an IP, or an endpoint's ceiling), the instance remembers it until its `Retry-After` ends and refuses it again in memory, with no Firestore read. A refused window stays full until it ends and the wait is rounded up, so the cache never lets through what the store would refuse; with more than one instance each keeps its own, which only refuses sooner. It holds at most 10,000 keys, dropping ended refusals first and then the oldest (a forgotten key is just checked in the store again).

## Client IP

`agent/src/client-ip.ts`: the right-most `X-Forwarded-For` entry, which Cloud Run appends and a caller can't forge. `/chat` and `/stats` are never behind Firebase Hosting and always key on it. Only on `/mcp`, through the site's rewrite, that entry is Hosting's own and the visitor is the entry to its left (measured in #36: Hosting sends `<visitor>,<hosting>` and drops forged values). So `/mcp` skips the right-most entry only when it is in Google's [user-triggered fetchers ranges](https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json), where #36 saw Hosting's peer. A caller that can send from those ranges could still choose its key.

A snapshot of the list ships with the agent (`agent/src/google-ranges.json`), with Google's own ranges ([`goog.json`](https://www.gstatic.com/ipranges/goog.json) minus [`cloud.json`](https://www.gstatic.com/ipranges/cloud.json)), used only to count `/mcp` hops that are Google's but not fetchers (`mcp.unknownGoogleHops` in the [usage stats](usage-stats.md#what-is-recorded), the sign the snapshot is stale), never for keying. Refresh all three with `pnpm agent:ranges` and commit the result; a weekly workflow does it and opens a PR ([Ranges refresh](deploy.md#ranges-refresh)). The live check that the keying holds is the [`/mcp` rate-limit check](deploy.md#mcp-rate-limit-check).

## Rate-limit key

The client IP, or its `/64` prefix for IPv6 (`rateLimitKeyFor`), so rotating addresses inside one network's block doesn't buy a fresh window; clients sharing a `/64` share a limit. IPv4 addresses, IPv4-mapped ones included, are keyed whole.

## Per-request token cap

One output-token budget (`AGENT_MAX_REQUEST_TOKENS`) shared by all the model calls of a request; when it runs out the request ends with `stopReason: "max_tokens"`.

## Monthly spend cap

`agent/src/spend-cap.ts`: before calling the model, each chat request reserves its worst-case cost (its whole output budget plus a generous input estimate) and is refused with `503 unavailable` if that doesn't fit in what's left of `MONTHLY_SPEND_CAP_USD` this UTC month, so concurrent requests can't overshoot together. Each model call's actual `usage` is then charged and the unused reservation released. A call cut off because the visitor left is still charged, conservatively, at its output cap plus its input. MCP tools cost nothing and keep working. The chat shows the visitor the date it reopens (`resetsAt`).

## Daily quota

`agent/src/daily-quota.ts`: each rate-limit key may spend `DAILY_SPEND_QUOTA_USD` of estimated model cost per UTC day on `/chat`, so a few sources can't spend the month's cap in minutes. It counts spend, not requests, with the same reservation as the spend cap: each chat request reserves its worst case against the key's quota first, then against the spend cap, so a long conversation counts for what it may cost. One that doesn't fit is refused like a rate limit: `429 rate_limited` with `Retry-After` and `retryAfterSeconds` until midnight UTC, plus `resetsAt`; the chat shows when the visitor can ask again. If the spend cap then refuses the request, the quota's reservation is released.

The default ($0.10) comes from `/stats`: about $0.0004 per answer measured in week 45, so $0.10 is some 250 short answers or a few dozen long ones, far beyond a real visitor, and still above a maximal request's worst case (about $0.02 on Claude Haiku 5.5; a short question reserves about $0.01). Forty keys a day are needed to spend the $4 cap.

## Provider spend limit

The Anthropic workspace has its own hard limit of $5 per month, set in the Claude Console: the spend cap counts estimated spend, so that is the hard limit. The code cap defaults to $4, below it, because the code cap only estimates spend (list prices from `agent/src/pricing.ts`, at the requested model's rates) and is the one with a graceful answer: it refuses before calling the model and says when the chat reopens. The provider limit is the backstop if the estimate is ever off; if it is hit (a 400 naming the usage limit, or a 402 `billing_error` when there is no credit), `agent/src/anthropic.ts` treats it like an outage and the stream ends with `unavailable`, not `internal`. Raise both together, keeping the code cap under the provider's. Hitting the provider limit logs the `provider_limit` [alert event](logs-and-alerts.md#alert-events), since it means the two have drifted apart.

## In memory

In memory, the cap is per instance and resets on every cold start. So in production (`NODE_ENV=production`, set in `agent/Dockerfile`) the agent refuses to start with `AGENT_STORE=memory` and says why, unless `AGENT_ALLOW_MEMORY_STORE=true` accepts it explicitly; the deploy never sets that. The agent is also deployed with Cloud Run `--max-instances=1`.

## Shared store

With `AGENT_STORE=firestore` the rate limits and the spend cap live in Firestore, so they are shared by every Cloud Run instance and survive cold starts: the month's spend no longer starts again at $0 when the service scales to zero. The agent talks to Firestore's REST API with plain `fetch` and the service account's token from the metadata server, so the bundle stays self-contained ([ADR 0003](adr/0003-agent-firestore-over-rest.md)). Creating the database is a one-time step in [Deploy](deploy.md#the-firestore-database); trying it locally against the emulator is in [Agent service](agent.md#running-it-locally).

- **Rate limits**: one document per limiter and client, `rateLimits/<chat|mcp|stats>:<key>` (the rate-limit key, URL-encoded), holding the current one-minute window (`start`, `count`) and `expireAt`, its end. Each endpoint's global ceiling is the document `rateLimits/<chat|mcp|stats>:*`, written once per request the per-IP limit allows; once the ceiling is reached, the refusal cache stops further writes to it until the window ends.
- **Spend**: one document per UTC month, `spend/<YYYY-MM>`, holding `spentUsd`, the `holds` of the requests running (each reservation's worst case and `expireAt`) and `alerted`, the alert events already fired this month (see [Logs and alerts](logs-and-alerts.md#alert-events)). A reservation whose instance died before settling stops counting after 15 minutes (Cloud Run's request timeout is 5); what that request spent stays charged.
- **Daily quota**: one document per rate-limit key and UTC day, `dailySpend/<YYYY-MM-DD>:<key>` (URL-encoded), shaped like the monthly spend document, with `expireAt`, the day's end, for the TTL policy.
- **Usage**: one document per ISO week, `usage/<YYYY-Www>`, with the week's aggregates (see [Usage stats](usage-stats.md#the-weekly-document)).
- **Concurrency**: every change is read, then committed with a precondition on the document's `updateTime` (or that it doesn't exist yet); if another request wrote in between, it is re-read and re-applied. So parallel requests can't both pass the limit or both fit under the same remaining room of a spend limit.
- **Cost**: a chat request is about two writes for its rate limits (per IP, global), two to reserve (daily quota and spend cap), two per model call, two to settle and one for its usage stats; an MCP request is three (rate limits, usage), a `/stats` call two (rate limits). A request the refusal cache refuses costs no rate-limit read. That is far inside Firestore's free tier (20K writes and 50K reads a day, on the `(default)` database).

### When the store fails

Every Firestore REST call (and the metadata server's token request) gives up after 3 s, so a hanging store fails fast instead of holding the request. Each route then follows its own policy (`agent/src/app.ts`):

- `/mcp` **fails open**: a failed rate-limit check lets the request through, so `get_contact` keeps answering. It is the contact fallback when the chat is down, and it costs nothing.
- `/stats` **fails open** on its rate limit too, and answers `503 unavailable` JSON if the aggregates can't be read; the page then hides its usage line.
- `/chat` **fails closed**: a failed rate-limit check or reservation (daily quota or spend cap) answers `503 unavailable` JSON (`errorMessages.unavailable`), so the chat never starts without a reservation, and the page falls back to `/mcp` for the contact.
- Any other error a route doesn't handle reaches the app's error handler, which answers in the route's contract (JSON on `/chat` and `/stats`, a JSON-RPC error `-32603` with `data.code: "unavailable"` on `/mcp`, both `503`), never a plain-text `500`; the CORS headers stay on.
- If recording a model call's usage fails once the answer is streaming, the error is logged, the answer goes on, and the request's reservation stays until it expires, covering that call's cost. Recording usage stats is best effort everywhere.
- Errors are logged with the collection only (`rateLimits`, `spend`, `dailySpend`, `usage`), never the document id, which can hold a client IP, nor Firestore's response body.
