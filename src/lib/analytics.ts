// Site analytics: PostHog EU Cloud, on in a build with NEXT_PUBLIC_POSTHOG_KEY
// and absent otherwise. What is collected and why: docs/analytics.md.
import type { CaptureOptions, PostHogConfig } from "posthog-js";
import type { ChatStopReason } from "@/shared/chat-contract";
import type { ChatErrorKind } from "./chat-client";
import type { Turn } from "./chat-session";
import { POSTHOG_API_HOST } from "./posthog-hosts";

/** The part of the SDK the page uses. */
export type PostHogClient = {
  init: (key: string, config: Partial<PostHogConfig>) => unknown;
  capture: (event: string, properties?: Record<string, unknown>, options?: CaptureOptions) => unknown;
};

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

/** Where a question to the chat came from: its input, or the contact section's button. */
export type QuestionSource = "input" | "contact";

/** How a question ended: the stream's stop reason, the error kind, the contact fallback, or abandoned. */
export type QuestionOutcome = ChatStopReason | ChatErrorKind | "contact_fallback" | "abandoned";

/** How an ended turn ended: a failure with no notice was aborted, as the visitor left. */
export function outcomeOf(turn: Turn): QuestionOutcome {
  const { status } = turn;
  switch (status.kind) {
    case "answered":
      return status.stopReason;
    case "fallback":
      return "contact_fallback";
    case "failed":
      return status.notice?.kind ?? "abandoned";
    case "streaming":
      return "abandoned";
  }
}

/**
 * The custom events the page reports, with their properties. The names and
 * properties are fixed: the dashboard views are built on them
 * (docs/analytics.md#events). None carries a question's or an answer's text.
 */
export type SiteEvent =
  | { event: "chat_question_sent"; properties: { source: QuestionSource } }
  | {
      event: "chat_question_ended";
      properties: { source: QuestionSource; outcome: QuestionOutcome; ms: number };
    }
  | { event: "mcp_command_copied"; properties?: undefined };

/** How many events wait for the SDK at most; later ones are dropped. */
const QUEUE_LIMIT = 20;

type Pending = { site: SiteEvent; options?: CaptureOptions };

// The module's state: the one place that says whether analytics is on (the
// components and `report` all ask `posthogKey()`), and the SDK or the events
// waiting for it.
let key: string | undefined;
let client: PostHogClient | null;
let queue: Pending[] | null;

/**
 * Starts the module over with `projectKey` as the build's key and no SDK
 * yet, the page's state at load. Called once below with the key the build
 * inlined (NEXT_PUBLIC_POSTHOG_KEY); tests call it to pick a build with or
 * without a key, so no state leaks from one test to the next.
 */
export function resetAnalytics(projectKey: string | undefined) {
  key = projectKey || undefined;
  client = null;
  queue = [];
}
resetAnalytics(process.env.NEXT_PUBLIC_POSTHOG_KEY);

/** This build's PostHog project key; none means no analytics. */
export const posthogKey = (): string | undefined => key;

/**
 * Reports `site` to PostHog: sent at once once the SDK has started, queued
 * until then, dropped if it failed to load. A no-op in a build without a key.
 * `leaving` sends it as the page goes away (a beacon, not batched).
 */
export function report(site: SiteEvent, { leaving = false } = {}) {
  if (!key) return;
  const options: CaptureOptions | undefined = leaving
    ? { transport: "sendBeacon", send_instantly: true }
    : undefined;
  if (client) client.capture(site.event, site.properties, options);
  else if (queue && queue.length < QUEUE_LIMIT) queue.push({ site, options });
}

/** Called once the SDK has started: sends what was queued, then every later event. */
export function attachClient(posthog: PostHogClient) {
  client = posthog;
  for (const { site, options } of queue ?? []) posthog.capture(site.event, site.properties, options);
  queue = null;
}

/** Called when the SDK failed to load: queued and later events are dropped. */
export function dropReports() {
  queue = null;
}
