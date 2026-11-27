The cookie notice: one prompt line fixed at the bottom left, saying the site uses a cookie for analytics, with an `[ok]` that only hides it.

**When to use.** Once per page, after the content (the site mounts it in the root layout, not in `Page`). It informs and asks nothing: `[ok]` changes nothing about what is collected, it only hides the line for good in that browser.

**When it shows.** Only in a build with site analytics (a PostHog key) and only until the visitor dismisses it. The bundle has no key, so this card renders it as a first visit to such a build.

**The consumer provides.** Nothing: the text is the site's copy.

Source: `src/components/cookie-notice.tsx`. Compiled from the repository, not hand-written.
