"use client";

import { useChatBridge } from "@/components/chat-bridge";
import { ExternalLink } from "./ui";

const linkStyle =
  "mt-6 inline-block max-w-full text-lg font-bold break-all text-blue underline decoration-border underline-offset-8 transition-colors hover:decoration-blue sm:text-2xl";

/**
 * The contact section's call to action: "ask my agent" sends the contact
 * question to the chat, which answers with the address (or falls back to the
 * MCP tools, then LinkedIn). The page itself never holds the address. Without
 * the chat (no JavaScript, or no agent in this build) it's a LinkedIn link,
 * which is also what the static HTML shows.
 */
export function ContactAsk({ linkedin }: { linkedin: string }) {
  const { state, askForContact } = useChatBridge();

  if (state === "absent") {
    return (
      <ExternalLink href={linkedin} className={linkStyle}>
        message me on LinkedIn ↗
      </ExternalLink>
    );
  }

  return (
    <button
      type="button"
      onClick={askForContact}
      disabled={state === "busy"}
      className={`${linkStyle} cursor-pointer disabled:cursor-wait disabled:opacity-50`}
    >
      ask my agent
    </button>
  );
}
