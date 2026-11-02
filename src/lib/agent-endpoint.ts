// Where the browser reaches the agent service. The static export can't read
// runtime env, so the base URL is inlined at build time from
// NEXT_PUBLIC_AGENT_URL (e.g. the Cloud Run URL for the deployed site) and
// defaults to the local service started by `pnpm agent:dev`.
export const DEFAULT_AGENT_URL = "http://localhost:8080";

export function agentEndpoints(base: string | undefined) {
  const root = (base || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  return { chat: `${root}/chat`, mcp: `${root}/mcp` };
}

// Must be referenced literally so Next can inline it into the client bundle.
export const agentUrls = agentEndpoints(process.env.NEXT_PUBLIC_AGENT_URL);
