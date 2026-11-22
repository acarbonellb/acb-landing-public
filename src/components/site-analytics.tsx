"use client";

import { useEffect } from "react";
import {
  attachClient,
  dropReports,
  loadPostHog,
  posthogConfig,
  posthogKey,
  type PostHogClient,
} from "@/lib/analytics";

/**
 * Starts site analytics once the page is interactive (docs/analytics.md).
 * Renders nothing; in a build without a key (`posthogKey`) it never loads the
 * SDK, and if the SDK fails to load the page goes on as if analytics were
 * off. Events reported before the SDK starts wait for it (`report`).
 */
export function SiteAnalytics({ load = loadPostHog }: { load?: () => Promise<PostHogClient> }) {
  useEffect(() => {
    const projectKey = posthogKey();
    if (!projectKey) return;
    let cancelled = false;
    const start = () =>
      load()
        .then((posthog) => {
          if (cancelled) return;
          posthog.init(projectKey, posthogConfig);
          attachClient(posthog);
        })
        .catch(dropReports);
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", start);
    };
  }, [load]);
  return null;
}
