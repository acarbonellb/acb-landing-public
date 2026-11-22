# Site analytics

The page reports its visits to PostHog (EU Cloud), a hosted product-analytics service with a ready-made web analytics dashboard, so the owner can see who visits, from where, and what they do, without building a dashboard. It is on only in a build with a PostHog project key; a build without one (a fork, a local build) loads nothing and sends nothing. The agent's own figures stay in the [usage stats](usage-stats.md).

## What is collected

The SDK runs in its standard configuration, for every visitor from the first page view, with its own persistence (a first-party cookie and local storage) so a returning visitor is recognised. Visitors stay anonymous: nothing identifies a person.

| Collected | Not collected |
| --- | --- |
| Page views, with the referrer, UTM parameters, country and device the SDK records | Anything that identifies a visitor (no `identify` call, no person profiles) |
| Page leaves, with scroll depth | Session replay, heatmaps, dead clicks, exceptions, web vitals |
| Autocaptured clicks (element and link, as the SDK ships it) | Surveys, feature flags, web experiments, product tours, conversations |
| | The agent's tokens, cost or any other agent-side figure |

The products in the right column are off in the SDK's configuration (`posthogConfig` in [`src/lib/analytics.ts`](../src/lib/analytics.ts)), whatever the PostHog project's settings say.

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
2. In its settings, turn session replay off (the SDK keeps it off anyway).
3. Copy the project API key into the repository variable `POSTHOG_KEY`. The next `main` deploy builds the site with it.

Until the variable exists, merged code changes nothing on the live site.

## Tests

| Suite | What it checks |
| --- | --- |
| Unit, `src/lib/security-headers.test.ts` | With a key, `connect-src` lists PostHog's two origins and nothing else changes; without one, the policy is today's |
| Unit, `src/components/site-analytics.test.tsx` | A build without a key never loads the SDK (CI's build has one once the variable is set) |
| Unit, `src/components/cookie-notice.test.tsx` | A build without a key renders no notice; `[ok]` is remembered, and still hides it when storage is blocked |
| Unit, `src/components/agent-chat.test.tsx` | The privacy note's analytics sentence shows only in a build with a key |
| Browser, `e2e/analytics.spec.ts` | Whichever build is under test: with a key, a page view reaches the PostHog stub, the SDK chunk loads after the page, no script comes from another origin and a blocked SDK breaks nothing; without one, nothing is requested |
| Browser, `e2e/cookie-notice.spec.ts` | With a key: the notice shows as one line at the bottom left, outside `main`, with no overflow; `[ok]` hides it across reloads and visits, from the keyboard too; axe passes with it visible in both themes, on Chromium and the phone (WebKit). Without one: no notice |
| Browser, `e2e/offline.spec.ts` | No test reaches a real PostHog host, even one that stubs nothing |

The `posthog` fixture in `e2e/fixtures.ts` answers PostHog's two origins and collects the events. The SDK drops events from automated browsers, so the fixture hides `navigator.webdriver` from the page.
