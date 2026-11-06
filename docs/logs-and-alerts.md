# Logs and alerts

The [agent](agent.md) logs one JSON object per line (`agent/src/log.ts`), which Cloud Logging parses natively: `severity` becomes the entry's severity, `message` its summary, and every other field lands in `jsonPayload`. `INFO` lines go to stdout, `WARNING` and `ERROR` to stderr. **No line carries message content, a client IP or the contact email**: only counts, ids, outcomes, months and weeks, and error messages that are scrubbed where they're made (Firestore errors name the collection, never the document id, which can hold a client IP; `agent/src/firestore.ts`). The startup banner (`main.ts`) is plain text.

## Fields on every line

| Field | Type | What |
| --- | --- | --- |
| `severity` | `"INFO"` \| `"WARNING"` \| `"ERROR"` | Cloud Logging severity |
| `event` | string | Stable event name (the tables below). Alerts and queries match on this, never on `message` |
| `message` | string | Human-readable summary; wording may change |
| `requestId` | string (UUID) | Set on every line logged while serving a request, absent otherwise. Each request gets a fresh one, also sent back as the `X-Request-Id` response header, so a chat's stream, its store writes and its alert events can be tied together |

## Request events

| `event` | Severity | Fields | When |
| --- | --- | --- | --- |
| `chat_request` | `INFO` | `outcome`, `inputTokens`, `outputTokens`, `costUsd`, `totalMs`, `firstTextMs`, `modelCalls` | Exactly once per `POST /chat` that reaches the route. `outcome` is the usage outcome (`end_turn`, `max_tokens`, `max_iterations`, `refusal`, `error:unavailable`, `error:internal`, `aborted`, `http_429`, `http_503`; see [Usage stats](usage-stats.md#what-is-recorded)) or `http_400` / `http_413` for a malformed or oversized body, or `http_503` for one that failed closed on a store error (none of these three are in the usage stats). `http_429` covers the per-IP limit, the global ceiling and the daily quota alike. Tokens are all the request's model calls, estimated ones included (`0` when refused before streaming); `costUsd` is the estimate at list prices; `totalMs` / `firstTextMs` are ms from arrival to the end of the stream / the first text, `null` when there was none; `modelCalls` counts model calls (`0` when refused) |
| `chat_failed` | `ERROR` | `error`, `stack` | A chat run hit a bug (the stream ends with `error:internal`) |
| `unhandled_error` | `ERROR` | `method`, `route`, `error`, `stack` | An error no route handled (or a store failing where the route fails closed), answered `503` in the route's contract |
| `store_error` | `ERROR` | `operation`, `error`, plus `route` (`rate_limit`), `guard` (`spend_cap` or `daily_quota`, on `spend_record` and `spend_settle`), `costUsd` (`spend_record`) | One store operation failed. `operation`: `rate_limit` (the route then fails open or closed), `usage_record` (a chat request, MCP request or batch of refusals), `usage_stats`, `spend_record`, `spend_settle`, `provider_limit`. One line per failure: for debugging, not alerting |

`error` is always `"<Name>: <message>"`, with ` (cause: ...)` appended when the error has a cause.

## Alert events

Each fires **once per crossing**, not once per request; the state lives in the [shared store](guardrails.md#shared-store), so it holds across instances and cold starts (in memory, per instance). These are what the Cloud Monitoring log-based alerts match on ([below](#alerts-cloud-monitoring)):

| `event` | Severity | Fields | Fires | State kept in |
| --- | --- | --- | --- | --- |
| `spend_threshold` | `WARNING` | `thresholdPercent` (`50` or `80`), `month` (`YYYY-MM`), `spentUsd`, `capUsd` | When a model call's charge first brings the month's `spentUsd` to at least 50%, then 80%, of `MONTHLY_SPEND_CAP_USD` (never with a `0` cap). Once each per month | `spend/<YYYY-MM>`: `alerted.threshold_50`, `alerted.threshold_80` |
| `spend_cap_reached` | `ERROR` | `month`, `spentUsd`, `capUsd`, `resetsAt` (ISO time the chat reopens: the next UTC month) | When the spend cap first refuses a chat request in the month. Once per month | `spend/<YYYY-MM>`: `alerted.refused` |
| `provider_limit` | `ERROR` | `month` | When a model call is refused by the provider's own spend or credit limit (a 400 naming the usage limit, or a 402 `billing_error`) and the limit wasn't already noted. Fires again only after `provider_limit_cleared` | `spend/<YYYY-MM>`: `alerted.provider_limit` (`true` while limited) |
| `provider_limit_cleared` | `INFO` | `month` | The next model call that succeeds after `provider_limit` | the same flag, set back to `false` |
| `chat_error_rate` | `ERROR` | `week` (`YYYY-Www`), `windowMinutes` (`60`), `streamed`, `errors`, `errorRate` (0 to 1), `threshold` | When, as a streamed chat request ends, the last hour's `error:*` share of streamed requests (all but `http_429` / `http_503`) goes above `ALERT_CHAT_ERROR_RATE`, with at least `ALERT_CHAT_ERROR_MIN_REQUESTS` streamed requests in the hour. Fires again only after `chat_error_rate_recovered` | `usage/<YYYY-Www>`: `alerted.chat_error_rate` (`true` while above), and `errorWindow` |
| `chat_error_rate_recovered` | `INFO` | same as `chat_error_rate` | When the hour's rate is back at or under the threshold (again with the minimum of requests) | the same flag, set back to `false` |
| `store_unavailable` | `ERROR` | `collection` (`rateLimits`, `spend`, `dailySpend` or `usage`), `error` | When a store update fails after the last one succeeded (or at the first). Fires again only after `store_recovered` | this instance's memory: the store can't record its own outage |
| `store_recovered` | `INFO` | `collection` | The next store update that succeeds after `store_unavailable` | the same |

"The last hour" is the current 10-minute bucket (UTC) and the five before it, so 50 to 60 minutes; the buckets live in the week's document, and a week's first streamed request starts its window, and the alert's state, from the end of the previous week's, so the hour runs on across Monday 00:00 UTC (each instance reads the previous week's document once a week for it). `spentUsd` is the month's charged spend, rounded to the micro-dollar; reservations of running requests aren't in it. Spend and provider-limit state start afresh each UTC month, with the month's document. The daily quota's documents (`dailySpend/...`) share the spend cap's reservation code (`agent/src/spend-holds.ts`) but have no alert events.

## Querying

In Cloud Logging, e.g. every alert event of the agent:

```
resource.type="cloud_run_revision" AND resource.labels.service_name="agent"
jsonPayload.event=("spend_threshold" OR "spend_cap_reached" OR "provider_limit" OR "chat_error_rate" OR "store_unavailable")
```

or one request's lines: `jsonPayload.requestId="<id>"`.

## Alerts (Cloud Monitoring)

Each alert event above with severity `WARNING` or `ERROR` has a log-based alert policy that emails the owner; the `INFO` ones (`_cleared`, `_recovered`) only log. They are GCP resources made by hand, not by the deploy, with `scripts/monitoring-alerts.sh` (which needs gcloud's beta component, `gcloud components install beta`, for notification channels):

| Policy | Matches (`jsonPayload.event`) | Severity | The email shows |
| --- | --- | --- | --- |
| `Agent: spend_threshold` | `spend_threshold` | Warning | `thresholdPercent`, `month`, `spentUsd`, `capUsd` |
| `Agent: spend_cap_reached` | `spend_cap_reached` | Error | `month`, `spentUsd`, `capUsd`, `resetsAt` |
| `Agent: provider_limit` | `provider_limit` | Error | `month` |
| `Agent: chat_error_rate` | `chat_error_rate` | Error | `errorRate`, `errors`, `streamed`, `threshold`, `week` |
| `Agent: store_unavailable` | `store_unavailable` | Error | `collection` |

Each matches `resource.type="cloud_run_revision" AND resource.labels.service_name="agent" AND jsonPayload.event="<event>"` (exact match, so `provider_limit_cleared` doesn't trigger `provider_limit`), sends at most one email per 5 minutes and closes its incident after 30 minutes without a match. All notify one email channel, `Agent alerts (email)`. The email shows only the fields above (label extractors), never `error` or `requestId`, plus what to do and a link to this page's [Alert events](#alert-events).

```bash
scripts/monitoring-alerts.sh setup --dry-run acb-landing "$ALERT_EMAIL"  # prints every gcloud command and file; runs nothing
scripts/monitoring-alerts.sh setup acb-landing "$ALERT_EMAIL"            # creates them, or updates them in place
scripts/monitoring-alerts.sh test acb-landing [event]                     # one synthetic alert event (default store_unavailable); wait ~10 min after a first setup
```

`setup` is idempotent: it enables the Monitoring API, then looks up the channel and each policy by display name and creates it, or replaces it with the script's version (two with the same name stop it: delete the extra). Re-run it after changing an alert event, the policies or the address, or to recreate them all in a rebuilt project. The email address is only an argument: it reaches gcloud in a temporary file (mode 600, deleted on exit), never on a command line, and the script never prints it (the dry run shows `<email>`); it is in no repo file, variable or workflow, like the contact address. Nothing in CI runs this script; `scripts/monitoring-alerts.test.ts` runs it against a fake `gcloud`, and checks it makes one policy per `WARNING` or `ERROR` row of the [Alert events](#alert-events) table.

`test` writes one log entry (`gcloud logging write`, log `agent-alert-test`) shaped like the agent's line for that event, on the `agent` Cloud Run service's resource, with `"test": true` and `"test"` as each field's value: its policy opens an incident and emails the channel within a few minutes. A newly created policy takes a few minutes to start matching, so after a first `setup` wait about 10 minutes before `test`: an entry written sooner is missed and sends nothing. Close the incident in the console, or let it close itself after 30 minutes.
