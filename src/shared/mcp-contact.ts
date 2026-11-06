// The contact fallback's one MCP call (#50): when the chat can't answer the
// "ask my agent" question, the page asks the agent's MCP server for the
// address straight from `get_contact`. No model, no spend; `/mcp` has its own
// rate limit. The server is stateless (docs/agent.md), so a single
// `tools/call` needs no `initialize` or session. Shared with the agent's tests,
// which run it against the real server.

/** The JSON-RPC answer to the `tools/call` of `get_contact`, as far as it is read. */
export type GetContactResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: { isError?: boolean; structuredContent?: { email?: unknown } };
};

/** The contact email from `get_contact`, or `null` when the call fails. */
export async function fetchContactEmail(
  url: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string | null> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Streamable HTTP requires both; the server answers plain JSON.
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_contact", arguments: {} },
      }),
      signal: options.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<GetContactResponse>;
    const email = body.result?.isError ? undefined : body.result?.structuredContent?.email;
    return typeof email === "string" && email.includes("@") ? email : null;
  } catch {
    return null;
  }
}
