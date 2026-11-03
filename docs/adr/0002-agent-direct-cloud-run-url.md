# Agent: browser calls the Cloud Run URL directly, not through a Hosting rewrite

The site is a static export on Firebase Hosting and the agent is a separate Cloud Run service. Hosting can proxy a path such as `/api/**` to Cloud Run, which would keep everything same-origin with no CORS. We tested it on the real project (#12): through the rewrite, Server-Sent Events are buffered and arrive all at once when the response ends. A stream longer than 60 s gets `503 first byte timeout`, and Hosting retries the request upstream, so one client request ran the service 7 times. For the chat, a retry re-runs the Claude loop and is billed again. So the browser calls the agent's own URL (`NEXT_PUBLIC_AGENT_URL`) and the agent allows only the site's origin on `/chat` (`ALLOWED_ORIGINS`). The MCP endpoint is served from the same URL.

## Considered options

- **Hosting rewrite (same origin).** Rejected: no incremental answer, long answers fail, retries multiply model spend. It also needs the service to be publicly invokable, which the direct URL needs anyway.
- **Load balancer in front of both.** Rejected for now: streams and supports custom paths, but it costs a fixed monthly fee, too much for a portfolio.

## Consequences

- `/chat` needs CORS, restricted to `ALLOWED_ORIGINS`. `/mcp` allows any origin because it's a public, read-only MCP server.
- The agent's base URL is inlined into the site at build time, so changing it (e.g. to a custom domain) needs a rebuild.
