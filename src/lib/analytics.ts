// Site analytics: PostHog EU Cloud, on in a build with NEXT_PUBLIC_POSTHOG_KEY
// and absent otherwise. What is collected and why: docs/analytics.md.
import type { PostHogConfig } from "posthog-js";
import { POSTHOG_API_HOST } from "./posthog-hosts";

/** The PostHog project key, inlined at build time; none means no analytics. */
export const posthogKey: string | undefined = process.env.NEXT_PUBLIC_POSTHOG_KEY || undefined;

/** The part of the SDK the page uses. */
export type PostHogClient = { init: (key: string, config: Partial<PostHogConfig>) => unknown };

/**
 * The SDK, in its own chunk: the build that never loads scripts from
 * PostHog's hosts, so the CSP's `script-src` stays `'self'`.
 */
export const loadPostHog = async (): Promise<PostHogClient> =>
  (await import("posthog-js/no-external")).default;

/** The SDK's standard configuration, with every product but analytics off. */
export const posthogConfig: Partial<PostHogConfig> = {
  api_host: POSTHOG_API_HOST,
  defaults: "2026-08-30",
  disable_session_recording: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  disable_web_experiments: true,
  advanced_disable_feature_flags: true,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_performance: false,
  disable_external_dependency_loading: true,
};
