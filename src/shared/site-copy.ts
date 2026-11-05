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
 * and the GCP config (PR for #46): re-check it when logging, the store or the
 * model provider changes. The agent's tests check that no tool serves it.
 */
export const chatPrivacyNote =
  "Your questions go to Claude (Anthropic) to answer. Conversations aren't stored: the weekly usage stats keep only counts, tokens, cost and latency. Server logs keep your IP, browser, time and status for 30 days. Per-IP counters, a rate limit that expires after a minute and a daily spend quota that expires at midnight UTC, are deleted within a day of expiring; a refused IP is also held in the agent's memory until its minute ends. The agent and its MCP server share my contact email on purpose.";

/**
 * What the contact section's "ask my agent" button sends to the chat, as the
 * visitor's message (#50). The eval case `on11` asks exactly this and is
 * gated in CI (ADR 0001), as it's the site's contact path.
 */
export const contactQuestion = "I'd like to contact Alberto, what's his email address?";
