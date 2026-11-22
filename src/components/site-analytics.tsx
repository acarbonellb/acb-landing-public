"use client";

import { useEffect } from "react";
import { loadPostHog, posthogConfig, posthogKey, type PostHogClient } from "@/lib/analytics";

/**
 * Starts site analytics once the page is interactive (docs/analytics.md).
 * Renders nothing; without a key it never loads the SDK, and if the SDK fails
 * to load the page goes on as if analytics were off.
 */
export function SiteAnalytics({
  projectKey = posthogKey,
  load = loadPostHog,
}: {
  projectKey?: string;
  load?: () => Promise<PostHogClient>;
}) {
  useEffect(() => {
    if (!projectKey) return;
    let cancelled = false;
    const start = () =>
      load()
        .then((posthog) => {
          if (!cancelled) posthog.init(projectKey, posthogConfig);
        })
        .catch(() => {});
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", start);
    };
  }, [projectKey, load]);
  return null;
}
