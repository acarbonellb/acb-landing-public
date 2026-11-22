// Copy only the page shows: no tool, tool description or system prompt reads
// it, so it never reaches the model and editing it makes no recording stale.
// What the tools serve lives in `profile.ts`. Shared (not in src/components/)
// because the agent's tests check against some of it.
import type { AgentStatus } from "./profile";

/** The hero terminal's `cat status.json`, in key order. */
export const heroStatus: Record<string, string | boolean> = {
  open_to_work: true,
  focus: "AI agents",
};

/** The badge an agent card shows for each status the CV states. */
export const agentStatusLabels: Record<AgentStatus, string> = {
  "in-progress": "in progress",
  "offline-evals": "offline evals · deployment next",
  "coming-soon": "coming soon",
  "personal-project": "personal project",
};

/** The agent section without an agent in this build (see `agent-endpoint.ts`). */
export const agentComingSoonNote =
  "Agent coming soon: a chat that answers questions about my experience and projects, also open to other agents over MCP.";

/**
 * Shown under the chat input. Each claim is checked against the agent's code
 * and the GCP config: re-check it when logging, the store or the
 * model provider changes. The agent's tests check that no tool serves it.
 * A build with site analytics adds `analyticsPrivacyNote`.
 */
export const chatPrivacyNote =
  "Your questions go to Claude (Anthropic) to answer. Conversations aren't stored: the weekly usage stats keep only counts, tokens, cost and latency. Server logs keep your IP, browser, time and status for 30 days. The rate limits count your IP in the agent's memory for a minute; a per-IP daily spend quota that expires at midnight UTC is deleted within a day of expiring. The agent and its MCP server share my contact email on purpose.";

/**
 * The privacy note's sentence on site analytics, in a build with a PostHog key
 * only. Checked against `posthogConfig` in `src/lib/analytics.ts` and the
 * events the page sends (docs/analytics.md).
 */
export const analyticsPrivacyNote =
  "The site uses PostHog (EU) with a cookie to measure visits and chat usage, never the text of questions or answers.";

/** The cookie notice's line: short enough to stay one line on a 360px phone. */
export const cookieNoticeText = "this site uses a cookie for analytics";

/**
 * The Contact question: what the contact section's "ask my agent" button
 * sends to the chat, as the visitor's message. The eval case `on11` asks
 * exactly this and is gated in CI (ADR 0001), as the page shows no address.
 */
export const contactQuestion = "I'd like to contact Alberto, what's his email address?";
