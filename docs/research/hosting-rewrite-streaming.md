# Can a Firebase Hosting rewrite to Cloud Run stream?

Desk research for #36 (Part 1). Sources accessed 2026-11-04. Labels: **documented** (official docs), **reported** (Firebase/Google staff or an issue tracker), **unconfirmed** (third party, or my inference).

## Bottom line

- No Firebase doc says rewrites stream. The docs don't mention streaming at all. The only statement found is from Michael Bleigh (Firebase), 2022: Hosting "does not currently support streaming responses" and "the entire response is buffered and cached in the CDN layer". That matches #12.
- No documented or reported header, padding size, protocol or method makes it stream. The 60 s limit is documented as fixed for every rewrite. It isn't configurable, and with buffering it effectively covers the whole response.
- Upstream retries aren't documented anywhere, and Hosting has no setting to turn them off. A rewrite is only safe for idempotent, short requests. `/mcp` fits that; `/chat` doesn't.
- No Firebase doc covers client IP through the rewrite. Measured (see **Measurements** below): Hosting reaches Cloud Run from Google-owned IPs (not Fastly's), sends `X-Forwarded-For: <visitor>, <Google peer>` and drops forged `X-Forwarded-For` / `Fastly-Client-IP` values. So: key on the right-most entry, and trust one more hop only when that peer is in Google's own ranges.
- To stream on the site's own domain, use the global external Application Load Balancer with a serverless NEG: about $18.25/month for the forwarding rule, plus $0.008/GiB. Domain mappings don't exist in `europe-southwest1`. App Hosting isn't offered in `europe-southwest1` and doesn't fit a static export.

## 1. Is streaming through a rewrite supported? Does the CDN buffer?

- The Hosting serverless overview, the Cloud Run integration page and the caching page say nothing about streaming, chunked or incremental responses (**documented**, by absence): [serverless-overview](https://firebase.google.com/docs/hosting/serverless-overview), [cloud-run](https://firebase.google.com/docs/hosting/cloud-run), [manage-cache](https://firebase.google.com/docs/hosting/manage-cache). The Firebase release notes have no entry about streaming either ([releases](https://firebase.google.com/support/releases)).
- Unsupported, buffered at the CDN (**reported**): Michael Bleigh, firebase-talk, 2022-08-01: "Firebase Hosting does not currently support streaming responses" … "The entire response is buffered and cached in the CDN layer" ([thread](https://groups.google.com/g/firebase-talk/c/OaLXVN50hfM)). The page shows only his name, not his affiliation. He is a Firebase engineer (he leads Hosting/web frameworks work), but that comes from my own knowledge, not from the page. I found no firebase-tools issue that contradicts it, or one that tracks it.
- Cloud Run streams natively when the app sends `Transfer-Encoding: chunked` (**documented**): "Cloud Run supports streaming HTTP responses. No configuration is required" ([https-request](https://docs.cloud.google.com/run/docs/triggering/https-request)). So the buffering happens in Hosting, not in Cloud Run. That fits #12's direct-URL result.
- The Hosting CDN is Fastly/Varnish (**unconfirmed**): the observed `x-cache` header and the Varnish error page point that way, but Firebase docs don't name the vendor. Fastly has a "Streaming Miss" feature that streams uncached responses ([Fastly](https://www.fastly.com/documentation/guides/full-site-delivery/performance/streaming-miss/)), but it's set in the service's configuration, which Firebase controls. #12 shows it isn't enabled for rewrites.

## 2. Any documented way to make it stream?

None found. Item by item:

- **Cache-Control (`no-store`, `private`)**: the docs say dynamic content already defaults to `private` and isn't CDN-cached by default: "By default, Firebase Hosting sets `Cache-Control` to `private` for dynamic content"; "requests that are handled by backend code do *not* cache on the CDN by default" ([manage-cache](https://firebase.google.com/docs/hosting/manage-cache), **documented**). Caching and buffering are separate: a response marked uncacheable was still buffered in #12. No source ties any header to streaming (**unconfirmed** either way).
- **Padding / size thresholds**: no source.
- **HTTP/2 end-to-end**: by default Cloud Run downgrades HTTP/2 to HTTP/1 toward the container ([https-request](https://docs.cloud.google.com/run/docs/triggering/https-request), **documented**). Nothing says this changes what Hosting does.
- **GET vs POST**: only GET and HEAD are cacheable ([manage-cache](https://firebase.google.com/docs/hosting/manage-cache), **documented**). #12 already measured POST: it was buffered too.
- **Content-Length**: no source.
- `firebase.json` `headers` only set **response** headers sent to the client: "Specify custom, file-specific response headers" ([full-config](https://firebase.google.com/docs/hosting/full-config), **documented**). There's no knob that reaches the proxy's buffering.

## 3. The 60 s limit

- **Documented and fixed**: "Even though Cloud Functions and Cloud Run have longer request timeouts, Firebase Hosting is subject to a 60-second request timeout. If your app requires more than 60 seconds to run, you'll receive an HTTPS status code 504" ([serverless-overview](https://firebase.google.com/docs/hosting/serverless-overview), also on [cloud-run](https://firebase.google.com/docs/hosting/cloud-run)). The [full-config](https://firebase.google.com/docs/hosting/full-config) rewrite schema has no timeout option, so it isn't configurable.
- The docs call it a "request timeout" and promise a `504`. #12 got `503 first byte timeout` instead. That's Fastly's wording: when `first_byte_timeout` fires, Fastly returns 503 "first byte timeout", and "for services with clustering enabled, the effective maximum `bereq.first_byte_timeout` is 60s" ([Fastly](https://www.fastly.com/documentation/reference/vcl/variables/backend-connection/bereq-first-byte-timeout/), **documented** for Fastly). So the limit is most likely time to first byte (**unconfirmed** for Hosting). Because Hosting buffers, the first byte only goes out when the response ends, so in practice the whole response has to fit in 60 s.

## 4. Upstream retries

- Not documented by Firebase: there's nothing on retries on the Hosting pages above, and the rewrite schema has no retry setting (**documented**, by absence). I found no issue-tracker report.
- Mechanism (**unconfirmed**): in Fastly, restarts and retries are a VCL configuration choice that Firebase controls. The #12 numbers (7 upstream requests over ~186 s, about 3 × 60 s) suggest edge and shield layers each retrying on first-byte timeout. If so, a stream whose first byte arrives in time shouldn't be retried, but buffering stops that from happening.
- For comparison, Google's own load balancer documents its retries and lets you turn them off: by default it retries "requests that have no HTTP body (for example, GET requests) that result in HTTP 502, 503, or 504" once; "HTTP POST requests aren't retried"; "to disable retries, you must explicitly set numRetries to 1" ([LB request distribution](https://docs.cloud.google.com/load-balancing/docs/https/request-distribution), **documented**).

## 5. Client IP through the rewrite

- No Firebase doc says which headers Hosting sends to the backend (**documented**, by absence).
- `Fastly-Client-IP` holds the visitor IP under Hosting rewrites (**reported**, community): Kato Richardson's gist says "For Firebase Hosting URIs, use req.headers['fastly-client-ip']", and its 2018 comments show `x-forwarded-for` holding a different address and say the behaviour "changed recently without any announcements" ([gist](https://gist.github.com/katowulf/6fffffb45ee5cbfbca6c3511e5d19528)). Fastly itself says that by default the header is "not protected from modification at the edge" and a client-supplied value is used ([Fastly](https://www.fastly.com/documentation/reference/http/http-headers/Fastly-Client-IP/), **documented** for Fastly). Whether Firebase overwrites it is **unconfirmed**: one gem README claims a forged value was replaced ([README](https://www.rubydoc.info/gems/firebase_hosting_client_ip/file/README.md)).
- Format and hop count of `X-Forwarded-For`: **unconfirmed**. The same README shows `client, google-hop`, and Arcjet reports "two IPs added" that "changed regularly and without notice" ([Arcjet](https://arcjet.com/learn/detect-client-ip-firebase)). The Google load balancer documents that it appends `client, LB IP` and "does not verify any IP addresses that precede" them ([LB overview](https://docs.cloud.google.com/load-balancing/docs/https)).
- **Getting an IP that can't be spoofed while `run.app` stays public** (my inference from the above):
  - Any header Hosting adds can be forged by a client that calls `run.app` directly.
  - Hosting can't add a secret request header (`headers` sets response headers only), so the backend can't authenticate "came through Hosting".
  - The only value an attacker can't forge is the entry Google's frontend appends to `X-Forwarded-For`: the right-most entry, which is the peer that connected to Cloud Run. That's what `TRUSTED_PROXY_HOPS=1` already uses.
  - So: take the right-most entry. If it's a Hosting peer, trust one more hop to the left; otherwise use the right-most entry.
  - The desk-research guess was that the peer would be a Fastly egress IP. **The measurement disproved it**: the peer is a Google IP (see **Measurements**).
  - Never trust `Fastly-Client-IP` alone.

## 6. Alternatives that keep the domain

- **(a) App Hosting.** It streams Next.js responses: App Hosting "supports advanced framework features … like streaming for Next.js" ([launch post, 2024-05-14](https://firebase.blog/posts/2024/05/introducing-app-hosting), **documented**, product blog). Requests go through a load balancer with Cloud CDN to Cloud Run ([about App Hosting](https://firebase.google.com/docs/app-hosting/about-app-hosting)). But:
  - its regions are us-central1, us-east4, us-east5, asia-east1, asia-southeast1 and europe-west4, with no `europe-southwest1` (**documented**, same page);
  - it would mean moving the site off the static export, with the agent still a separate service behind a proxy;
  - SSE behaviour through its CDN isn't documented (**unconfirmed**).
- **(b) Cloud Run domain mappings.** Still Preview: "not production-ready and are not supported at General Availability", and you can only map the root path `/`. They're available in asia-east1, asia-northeast1, asia-southeast1, europe-north1, europe-west1, europe-west4, us-central1, us-east1, us-east4 and us-west1 only, so **not in `europe-southwest1`** ([mapping-custom-domains](https://docs.cloud.google.com/run/docs/mapping-custom-domains), [locations](https://docs.cloud.google.com/run/docs/locations), **documented**). A subdomain like `agent.albertocarbonell.dev` would need the service moved to, say, europe-west1.
- **(c) Global external ALB + serverless NEG.** The docs say nothing about buffering. Cloud Run's streaming docs set no proxy condition, and the backend timeout is a whole-response limit of 60 minutes: "For backend services with serverless NEG backends, the default timeout is 60 minutes. This timeout is not configurable" ([serverless NEG concepts](https://docs.cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts); [request distribution](https://docs.cloud.google.com/load-balancing/docs/https/request-distribution), **documented**). That it actually streams SSE is **unconfirmed** in the docs, though ADR 0002 assumes it does. Retries are documented, POST isn't retried, and you can turn them off (see §4). The client IP is documented (§5). Cost: "First 5 forwarding rules $0.025 / 1 hour", which is about $18.25/month for up to 5 rules (an HTTP→HTTPS redirect rule fits in that tier), plus $0.008/GiB processed in each direction ([network pricing](https://cloud.google.com/vpc/network-pricing), **documented**).
- **(d) Other notes.**
  - Rewrites to Cloud Run are supported in `europe-southwest1` ([cloud-run](https://firebase.google.com/docs/hosting/cloud-run), **documented**).
  - Hosting adds `Cookie`/`Authorization` to `Vary` and strips every cookie except `__session` ([manage-cache](https://firebase.google.com/docs/hosting/manage-cache)). That's harmless for `/mcp`, but cookie-based auth through the rewrite won't work.
  - The Cloud Functions page suggests "App Engine flexible environment" for work over 60 s ([functions](https://firebase.google.com/docs/hosting/functions)). That isn't relevant here.

## Measurements (2026-11-04)

Throwaway probe: a Cloud Run service `ip-probe` (europe-southwest1, `node:22-alpine`, max 1 instance) that echoed request headers and counted requests per nonce, behind a Hosting preview channel with `/api/** → ip-probe`. Both were deleted afterwards. `<visitor>` is the test client's public IPv4.

| Path | Sent | `X-Forwarded-For` at Cloud Run | `Fastly-Client-IP` |
| --- | --- | --- | --- |
| direct `run.app` | nothing | `<visitor>` | none |
| direct `run.app` | `XFF: 1.2.3.4`, `Fastly-Client-IP: 5.6.7.8` | `1.2.3.4,<visitor>` | `5.6.7.8` |
| Hosting rewrite | nothing | `<visitor>,66.249.93.229` | `<visitor>` |
| Hosting rewrite | `XFF: 1.2.3.4`, `Fastly-Client-IP: 5.6.7.8` | `<visitor>,66.249.93.199` | `<visitor>` |

- **Hosting overwrites both headers.** Forged values don't survive the rewrite. Directly on `run.app` they pass through as-is, as expected.
- **The peer is Google, not Fastly.** `66.249.93.229` and `66.249.93.199` are in [`goog.json`](https://www.gstatic.com/ipranges/goog.json) (`66.249.64.0/19`) and in Google's [`user-triggered-fetchers-google.json`](https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json) (`66.249.93.192/27`, `66.249.93.224/27`). They are not in [`cloud.json`](https://www.gstatic.com/ipranges/cloud.json) (Google Cloud customer ranges) or in Fastly's list.
- **Rule for the rate limiter.** Take the right-most `X-Forwarded-For` entry (Google's frontend appends it, so it can't be forged). If it's in Google's own ranges (in `goog.json`, not in `cloud.json`), the request came through Hosting, so use the entry to its left. Otherwise use the right-most entry.
  - A direct caller can't fake this: their own IP is always the right-most entry.
  - Residual risk: a Google-operated fetcher calling `run.app` directly. That's acceptable for a per-IP limit.
  - The peer range isn't documented as Hosting's and may change, so read the published lists rather than hard-coding a /27.
- **Retries (one client request each, three runs):**
  - `GET` that got a `503`: 2 upstream requests, so Hosting retries a failed GET once.
  - `POST` that got a `503`: 1. `POST` `200`: 1. `GET` `200`: 1.
  - So POST isn't retried. MCP Streamable HTTP sends its calls as `POST`, so `/mcp` runs once per call.
- **Caching:** a repeated `GET` on the same URL reached the service again; dynamic responses aren't cached, as documented.

## Experiments still worth running (from #36)

Still open:

- ~~Client IP through the rewrite~~ and ~~retry conditions for a short `/mcp` call~~: done, see **Measurements**.
- **Load balancer streaming**, only if the fixed cost becomes acceptable: the docs don't confirm it streams SSE.

Made pointless (or low value) by the sources:

- **Other cache headers**: dynamic responses are already `private` and uncached by default. Caching isn't what's buffering, and a Firebase engineer says the whole response is buffered.
- **Padding / size thresholds**, **HTTP/2 end-to-end**, **with/without Content-Length**: nothing documented or reported supports them, and Cloud Run already streams. A quick padding probe is the only cheap long shot left.
- **POST vs GET**: already measured in #12 (both buffered).
- **Is 60 s time to first byte or the whole response?** It only matters once streaming works, and the limit is fixed anyway.
- **Turning off retries on the rewrite**: Hosting has no setting for it.
- **App Hosting and domain mapping in `europe-southwest1`**: neither is offered there.
