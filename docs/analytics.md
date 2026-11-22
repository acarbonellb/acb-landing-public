# Site analytics

The page reports its visits to PostHog (EU Cloud), a hosted product-analytics service with a ready-made web analytics dashboard, so the owner can see who visits, from where, and what they do, without building a dashboard. It is on only in a build with a PostHog project key; a build without one (a fork, a local build) loads nothing and sends nothing. The agent's own figures stay in the [usage stats](usage-stats.md).

## What is collected

The SDK runs in its standard configuration, for every visitor from the first page view, with its own persistence (a first-party cookie and local storage) so a returning browser is recognised. The page never says who a visitor is (no `identify` call, no person profiles), and the PostHog project must discard the client IP address PostHog otherwise stores with each event ([The PostHog project](#the-posthog-project), step 2): the cookie's random ID then ties a browser's visits together, not to a person. The country is still derived from the IP before it is discarded.

| Collected | Not collected |
| --- | --- |
| Page views, with the referrer, UTM parameters, country and device the SDK records | Who a visitor is (no `identify` call, no person profiles) and their IP address (discarded by the project's setting, not by the page) |
| Page leaves, with scroll depth | Session replay, heatmaps, dead clicks, exceptions, web vitals |
| Autocaptured clicks (element and link, as the SDK ships it) | Surveys, feature flags, web experiments, product tours, conversations |
| | The agent's tokens, cost or any other agent-side figure |

The products in the right column are off in the SDK's configuration (`posthogConfig` in [`src/lib/analytics.ts`](../src/lib/analytics.ts)), whatever the PostHog project's settings say.

## Events

Besides what the SDK collects on its own, the page reports three events about the chat, typed in one place (`SiteEvent` in [`src/lib/analytics.ts`](../src/lib/analytics.ts)) that the components call. Their names and properties are fixed: the dashboard views are built on them.

| Event | Properties | Sent when |
| --- | --- | --- |
| `chat_question_sent` | `source` | A question goes to the chat |
| `chat_question_ended` | `source`, `outcome`, `ms` | Its answer ends, fails or is abandoned |
| `mcp_command_copied` | none | The MCP command is copied to the clipboard |

| Property | Values |
| --- | --- |
| `source` | `input` (typed into the chat) or `contact` (the contact section's "ask my agent" button) |
| `outcome` | The stream's stop reason (`end_turn`, `max_tokens`, `max_iterations`, `refusal`); the error kind (`rate_limited`, `unavailable`, `error`, also when asking threw, the contact fallback included); `contact_fallback` (the contact fallback answered); or `abandoned` (the visitor left, or the chat went away, while it streamed). Every `chat_question_sent` gets exactly one `chat_question_ended` |
| `ms` | Milliseconds from sending the question to its end, measured in the browser |

No event carries the text of a question or an answer. The chat's transcript and input have the `ph-no-capture` class, so autocapture ignores clicks inside them: a click on the contact address the chat links sends nothing.

Events reported before the SDK has loaded wait in a queue (up to 20) and are sent once it has; if it never loads, they are dropped. In a build without a key, reporting an event does nothing. An abandoned question is sent with a beacon as the page goes away.

### Why the counts differ from the usage stats

The [usage stats](usage-stats.md) stay the exact figures for the agent. PostHog's counts are lower or different because:

| Cause | Effect |
| --- | --- |
| Tracker blockers | Their visitors' questions reach the agent but no event reaches PostHog |
| MCP clients | They call the agent directly; the page never sees them |
| Different outcome names | `rate_limited` and `unavailable` here are `http_429`, `http_503` or `error:unavailable` there; `abandoned` is `aborted` |
| Requests that never reached the agent | A network failure is `error` here and absent there |
| Answers by the contact fallback | `contact_fallback` here; there, the chat request that failed, and an MCP request |

## How the page loads it

| What | How |
| --- | --- |
| SDK | `posthog-js`, pinned in `package.json`, added within pnpm's minimum release age (no exclusion) |
| Build | `posthog-js/no-external`: it never loads scripts from PostHog's hosts, so `script-src` stays `'self'` |
| When | In its own chunk, imported once the page has loaded (`SiteAnalytics`, [`src/components/site-analytics.tsx`](../src/components/site-analytics.tsx)); it is not in the initial JavaScript |
| Where it sends | `https://eu.i.posthog.com` (events) and `https://eu-assets.i.posthog.com` (remote config), the two origins the CSP's `connect-src` gains in a build with the key ([Security headers](deploy.md#security-headers)) |
| If it fails | A blocked or failed load is ignored: the page and the chat work as if analytics were off |

## Cookie notice

Every visitor is measured from the first page view, so one line tells them: the cookie notice, a zsh-style prompt line fixed at the bottom left of the window (`CookieNotice`, [`src/components/cookie-notice.tsx`](../src/components/cookie-notice.tsx)). It informs; it is not a consent prompt and has no decline. This is the owner's decision for a personal portfolio, taken knowing that continued browsing is not valid consent under EU guidance.

| What | How |
| --- | --- |
| Shown | In a build with the key only, on the client after hydration: the static HTML has no notice, and being fixed it shifts nothing |
| Looks | A prompt glyph, the line and `[ok]`, with only the page's background behind it; the same on a phone, where it stays one line |
| `[ok]` | Hides it; the browser remembers in local storage (`cookie-notice`), as it remembers the theme. Collection doesn't change |
| Accessibility | A region labelled "Cookie notice", outside `main`; `[ok]` is a button with the site's focus style |

With site analytics on, the chat's privacy note adds one sentence (`analyticsPrivacyNote` in [`src/shared/site-copy.ts`](../src/shared/site-copy.ts)): PostHog (EU), a cookie, visits and chat usage, never the text of questions or answers.

## Switching it on

The project key comes from `NEXT_PUBLIC_POSTHOG_KEY` at build time, which CI sets from the repository variable `POSTHOG_KEY` ([Repository variables](deploy.md#repository-variables)). The key is public by nature: it is in the page's JavaScript and only allows sending events. Without it the SDK's chunk is never requested and the CSP is the same as before analytics, byte for byte.

## The PostHog project

Set up once, by the owner, by hand; nothing in the deploy creates or configures it:

1. Create a project in PostHog Cloud, **EU region**.
2. **Discard client IP data.** PostHog stores the client IP address with every event unless the project says otherwise, and the page can't prevent it. In the project's settings (Settings > Project, "IP data capture configuration"), turn on **Discard client IP data**. Check it before setting the variable below, and again whenever the project is recreated: open a recent `$pageview` in the activity view and confirm it has no `$ip` property. PostHog's docs say EU organizations default new projects to discarding it; that default was not checked here, so confirm the toggle rather than rely on it. Without this setting, the [privacy claims](#what-is-collected) above don't hold.
3. In its settings, turn session replay off (the SDK keeps it off anyway).
4. Copy the project API key into the repository variable `POSTHOG_KEY`. The next `main` deploy builds the site with it.

Until the variable exists, merged code changes nothing on the live site.

## Tests

| Suite | What it checks |
| --- | --- |
| Unit, `src/lib/security-headers.test.ts` | With a key, `connect-src` lists PostHog's two origins and nothing else changes; without one, the policy is today's |
| Unit, `src/components/site-analytics.test.tsx` | A build without a key never loads the SDK (CI's build has one once the variable is set) |
| Unit, `src/components/cookie-notice.test.tsx` | A build without a key renders no notice; `[ok]` is remembered, and still hides it when storage is blocked |
| Unit, `src/components/agent-chat.test.tsx` | The privacy note's analytics sentence shows only in a build with a key |
| Unit, `src/components/use-agent-chat.test.ts` | Every question sent is reported ended once: with its stop reason or error kind, `error` when the request or the contact fallback throws, `abandoned` when the chat unmounts or the visitor leaves mid-answer |
| Browser, `e2e/analytics.spec.ts` | Whichever build is under test: with a key, a page view reaches the PostHog stub, the SDK chunk loads after the page, no script comes from another origin and a blocked SDK breaks nothing; each [event](#events) arrives with its properties for every source and outcome, also when asked before the SDK loaded, and no payload holds a question, an answer or the contact address; without one, nothing is requested, even while chatting |
| Browser, `e2e/cookie-notice.spec.ts` | With a key: the notice shows as one line at the bottom left, outside `main`, with no overflow; `[ok]` hides it across reloads and visits, from the keyboard too; axe passes with it visible in both themes, on Chromium and the phone (WebKit). Without one: no notice |
| Browser, `e2e/offline.spec.ts` | No test reaches a real PostHog host, even one that stubs nothing |

Whether analytics is on has one seam: `posthogKey()` in `src/lib/analytics.ts`, which `report`, `SiteAnalytics`, `CookieNotice` and the chat's privacy note all read. Unit tests pick a build with or without a key with `resetAnalytics`, which also empties the event queue; `vitest.setup.ts` starts every test without one.

The `posthog` fixture in `e2e/fixtures.ts` is automatic: in every browser test it answers PostHog's two origins and collects the events, except where a spec sets `test.use({ postHog: "refused" })` (`offline.spec.ts`). Every test also starts with the cookie notice already dismissed, so the fixed line never covers what a test taps; `cookie-notice.spec.ts` sets `test.use({ cookieNotice: "shown" })`. The SDK drops events from automated browsers, so the fixture hides `navigator.webdriver` from the page. Its remote config answers like a new project's (`autocapture_opt_out: false`), as autocapture waits for it. Playwright can't intercept a beacon from a page being unloaded, so the abandoned test fires `pagehide` on a page that stays open.
