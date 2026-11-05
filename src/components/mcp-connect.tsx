"use client";

import { useState } from "react";
import { TerminalButton } from "./ui";

/** How to connect your own agent to the MCP server, with a command to copy. */
export function McpConnect({ mcpUrl }: { mcpUrl: string }) {
  const [copied, setCopied] = useState(false);
  const command = `claude mcp add --transport http albertocarbonell ${mcpUrl}`;

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: the command stays visible to select by hand.
    }
  }

  return (
    <div className="border-t border-border pt-5 text-sm">
      <p className="text-comment">
        {"// connect your own agent over MCP (Streamable HTTP)"}
      </p>
      <p className="mt-2 break-words">
        <span className="text-fg-dark">endpoint: </span>
        <code className="text-cyan">{mcpUrl}</code>
      </p>
      <div className="mt-3 flex items-start gap-2 rounded border border-border bg-bg px-3 py-2">
        <span className="text-green" aria-hidden>
          $
        </span>
        <code className="min-w-0 flex-1 break-words whitespace-pre-wrap text-fg">
          {command}
        </code>
        <TerminalButton onClick={copyCommand} className="shrink-0 px-2 py-0.5 text-fg-dark">
          {copied ? "copied" : "copy"}
          <span className="sr-only"> MCP command</span>
        </TerminalButton>
      </div>
    </div>
  );
}
