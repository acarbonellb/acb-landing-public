// PostHog EU Cloud's two origins: the page sends events to the ingestion host
// and fetches its remote config from the assets host (docs/analytics.md).
// Shared by the SDK's setup and the CSP, which runs under plain Node: keep it
// free of imports.
export const POSTHOG_API_HOST = "https://eu.i.posthog.com";
export const POSTHOG_ASSETS_HOST = "https://eu-assets.i.posthog.com";
