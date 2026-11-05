# Agent: browser calls the Cloud Run URL directly, not through a Hosting rewrite

The site is a static export on Firebase Hosting and the agent is a separate Cloud Run service. Hosting can proxy a path such as `/api/**` to Cloud Run, which would keep everything same-origin with no CORS. We tested it on the real project (#12): through the rewrite, Server-Sent Events are buffered and arrive all at once when the response ends. A stream longer than 60 s gets `503 first byte timeout`, and Hosting retries the request upstream, so one client request ran the service 7 times. For the chat, a retry re-runs the Claude loop and is billed again. So the browser calls the agent's own URL (`NEXT_PUBLIC_AGENT_URL`) and the agent allows only the site's origin on `/chat` (`ALLOWED_ORIGINS`).

The MCP endpoint is the exception: it is published on the site's domain, `https://albertocarbonell.dev/mcp`, through a Hosting rewrite to the same service (#36). Its responses are short JSON, so buffering doesn't matter and they never get near the 60 s limit.

## Revisited in #36

We looked again for a way to make the rewrite stream ([research notes](../research/hosting-rewrite-streaming.md)). It can't:

- **Streaming**: the Firebase docs say nothing about it. A Firebase engineer said Hosting "does not currently support streaming responses" and that the whole response is buffered in the CDN layer. No header, padding, protocol or method is documented or reported to change that.
- **60 s limit**: fixed for every rewrite. Because Hosting buffers, the whole response has to fit in it.
- **Retries**: undocumented and can't be turned off. Measured: a `GET` that got a `503` reached the service twice; a `POST` (failed or not) reached it once. MCP calls are `POST`, so `/mcp` runs once per call.
- **Client IP**: Hosting replaces `X-Forwarded-For` with `<visitor>,<hosting>`, dropping forged values, and its peer is in Google's user-triggered fetchers ranges. On `/mcp` the rate limiter takes the right-most entry, or the one to its left when the right-most is in those ranges, so the per-IP limit keys on the visitor whether the request comes through the rewrite or straight to `run.app`. `/chat` and `/stats` are never behind Hosting and always take the right-most entry.

## Considered options

- **Hosting rewrite for the chat (same origin).** Rejected: no incremental answer, long answers fail, retries multiply model spend. It also needs the service to be publicly invokable, which the direct URL needs anyway.
- **Load balancer in front of both.** Rejected for now: about $18/month fixed, too much for a portfolio. Retries can be turned off, but the docs don't confirm it streams SSE.
- **Cloud Run domain mapping on a subdomain, or App Hosting.** Not offered in `europe-southwest1`; domain mappings are still Preview.

## Consequences

- `/chat` needs CORS, restricted to `ALLOWED_ORIGINS`. `/mcp` allows any origin because it's a public, read-only MCP server.
- The agent's base URL is inlined into the site at build time, so changing it (e.g. to a custom domain) needs a rebuild.
- Recognising Hosting's hop depends on a committed snapshot of Google's user-triggered fetchers ranges (`agent/src/google-ranges.json`, refreshed with `pnpm agent:ranges`). If Hosting moves to an address outside it, visitors through the rewrite share Hosting's IP as their rate-limit key until the snapshot is refreshed. The hop is trusted only for that range and only on `/mcp`: a caller that can send requests from that range could still choose its `/mcp` key by forging the entry to its left.
- Once the client IP is chosen, an IPv6 address is keyed on its `/64` prefix (`rateLimitKeyFor` in `agent/src/client-ip.ts`), on `/chat`, `/stats` and `/mcp` alike, so a client can't get a fresh window by rotating addresses inside the block its network gave it. Visitors sharing a `/64` share a limit; IPv4 keys, IPv4-mapped ones included, stay the whole address.
