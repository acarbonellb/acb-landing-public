"use client";

import { useState, useSyncExternalStore } from "react";
import { posthogKey } from "@/lib/analytics";
import { COOKIE_NOTICE_DISMISSED, COOKIE_NOTICE_STORAGE_KEY } from "@/lib/cookie-notice";
import { cookieNoticeText } from "@/shared/site-copy";

const noSubscription = () => () => {};
function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(COOKIE_NOTICE_STORAGE_KEY) === COOKIE_NOTICE_DISMISSED;
  } catch {
    return false;
  }
}

/**
 * The cookie notice (docs/analytics.md#cookie-notice): one prompt line at the
 * bottom left saying the site uses an analytics cookie. It informs, it doesn't
 * ask: `[ok]` only hides it. Only in a build with a PostHog key, and only on
 * the client: the server snapshot counts as dismissed, so the static HTML and
 * hydration render nothing.
 */
export function CookieNotice() {
  const dismissedEarlier = useSyncExternalStore(noSubscription, dismissedBefore, () => true);
  const [dismissed, setDismissed] = useState(false);
  if (!posthogKey() || dismissedEarlier || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(COOKIE_NOTICE_STORAGE_KEY, COOKIE_NOTICE_DISMISSED);
    } catch {}
  }

  return (
    <section
      aria-label="Cookie notice"
      className="fixed bottom-0 left-0 z-50 flex items-baseline gap-2 bg-bg px-4 py-1.5 text-xs whitespace-nowrap text-fg-dark sm:px-6"
    >
      <span aria-hidden className="text-green">
        ❯
      </span>
      <p>{cookieNoticeText}</p>
      <button
        type="button"
        onClick={dismiss}
        className="cursor-pointer text-blue transition-colors hover:text-cyan focus-visible:text-cyan"
      >
        [ok]
      </button>
    </section>
  );
}
