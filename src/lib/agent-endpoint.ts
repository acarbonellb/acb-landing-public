// Where the browser reaches the agent service. The static export can't read
// runtime env, so the base URL is inlined at build time from
// NEXT_PUBLIC_AGENT_URL (e.g. the Cloud Run URL for the deployed site). Local
// `next dev` (and tests) default to the service started by `pnpm agent:dev`;
// a production build without the variable has no agent (`null`), so the page
// never publishes a localhost chat or MCP command.
export const DEFAULT_AGENT_URL = "http://localhost:8080";

export type AgentEndpoints = { chat: string; mcp: string };

export function agentEndpoints(
  base: string | undefined,
  nodeEnv: string | undefined,
): AgentEndpoints | null {
  if (!base && nodeEnv === "production") return null;
  const root = (base || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  return { chat: `${root}/chat`, mcp: `${root}/mcp` };
}

// Must be referenced literally so Next can inline them into the client bundle.
export const agentUrls = agentEndpoints(
  process.env.NEXT_PUBLIC_AGENT_URL,
  process.env.NODE_ENV,
);
