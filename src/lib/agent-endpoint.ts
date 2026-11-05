// Where the browser reaches the agent service. The static export can't read
// runtime env, so the base URL is inlined at build time from
// NEXT_PUBLIC_AGENT_URL (e.g. the Cloud Run URL for the deployed site). Local
// `next dev` (and tests) default to the service started by `pnpm agent:dev`;
// a production build without the variable has no agent (`null`), so the page
// never publishes a localhost chat or MCP command.
//
// The chat always calls the agent's own URL (a Hosting rewrite can't stream,
// ADR 0002), and so does the usage line (`/stats`). A production build shows MCP on the site's domain instead: the
// `/mcp` rewrite in firebase.json proxies it to the same service.
import { SITE_URL } from "./site";

export const DEFAULT_AGENT_URL = "http://localhost:8080";

export type AgentEndpoints = { chat: string; mcp: string; stats: string };

export function agentEndpoints(
  base: string | undefined,
  nodeEnv: string | undefined,
): AgentEndpoints | null {
  const production = nodeEnv === "production";
  if (!base && production) return null;
  const root = (base || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  return {
    chat: `${root}/chat`,
    mcp: `${production ? SITE_URL : root}/mcp`,
    stats: `${root}/stats`,
  };
}

// Must be referenced literally so Next can inline them into the client bundle.
export const agentUrls = agentEndpoints(
  process.env.NEXT_PUBLIC_AGENT_URL,
  process.env.NODE_ENV,
);
