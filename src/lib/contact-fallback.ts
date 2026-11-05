// The contact fallback (#50): when the chat can't answer the contact
// question, the page answers it without the model, with the address from the
// MCP `get_contact` tool, or, when that fails too, with a LinkedIn link. The
// contact section builds it and hands it to the chat's `ask` as a strategy;
// this module owns what it does.
import type { ChatErrorKind } from "./chat-client";
import { fetchContactEmail } from "@/shared/mcp-contact";

/** How the contact question was answered instead of by the chat. */
export type ContactFallback =
  | { kind: "tools"; reason: ChatErrorKind; email: string }
  | { kind: "linkedin"; url: string };

/** Answers a failed question, given why the chat failed. */
export type FallbackStrategy = (
  failure: ChatErrorKind,
  signal: AbortSignal,
) => Promise<ContactFallback>;

/**
 * The contact fallback that calls the agent's MCP server at `mcpUrl`, and
 * points to `linkedin` when that fails too.
 */
export function contactFallback(
  mcpUrl: string,
  linkedin: string,
  options: { fetch?: typeof fetch } = {},
): FallbackStrategy {
  return async (failure, signal) => {
    const email = await fetchContactEmail(mcpUrl, { fetch: options.fetch, signal });
    return email ? { kind: "tools", reason: failure, email } : { kind: "linkedin", url: linkedin };
  };
}
