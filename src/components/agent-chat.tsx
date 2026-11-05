"use client";

import { type FormEvent, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { chatRequestLimits } from "@/shared/chat-contract";
import { chatPrivacyNote } from "@/shared/site-copy";
import { type BridgeAsk, connectChat } from "./chat-bridge";
import { ChatNotice } from "./chat-notice";
import { ChatTranscript } from "./chat-transcript";
import { McpConnect } from "./mcp-connect";
import { TerminalButton } from "./ui";
import { useAgentChat } from "./use-agent-chat";

export function AgentChat({
  chatUrl,
  mcpUrl,
  fetch,
}: {
  chatUrl: string;
  /** Shown to visitors for their own MCP clients. */
  mcpUrl: string;
  fetch?: typeof globalThis.fetch;
}) {
  const { turns, notice, busy, ask } = useAgentChat({ chatUrl, fetch });
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bridge = useRef<ReturnType<typeof connectChat> | null>(null);
  const inputId = useId();

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;
    setDraft("");
    void ask(question);
  }

  // A question from outside the chat ("ask my agent" in the contact section):
  // bring the chat into view, focus it and send the question as the visitor's
  // message. A failure is answered by the caller's fallback instead of a notice.
  const askFromBridge = useEffectEvent<BridgeAsk>((question, options) => {
    if (busy) return;
    logRef.current?.closest("section")?.scrollIntoView?.({ block: "start" });
    inputRef.current?.focus({ preventScroll: true });
    void ask(question, options);
  });

  useEffect(() => {
    const connection = connectChat((question, options) => askFromBridge(question, options));
    bridge.current = connection;
    return () => {
      connection.disconnect();
      bridge.current = null;
    };
  }, []);

  useEffect(() => {
    bridge.current?.setBusy(busy);
  }, [busy]);

  return (
    <div className="space-y-6">
      <ChatTranscript ref={logRef} turns={turns} busy={busy} />

      {notice && <ChatNotice notice={notice} mcpUrl={mcpUrl} />}

      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 rounded border border-border px-3 py-2 text-sm focus-within:border-blue"
      >
        <label htmlFor={inputId} className="sr-only">
          Ask the agent a question
        </label>
        <span className="text-green" aria-hidden>
          ❯
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={chatRequestLimits.maxMessageChars}
          autoComplete="off"
          placeholder="ask about my experience, projects, stack…"
          // 16px on phones: iOS Safari zooms in on focus into any smaller field.
          className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-comment sm:text-sm"
        />
        <TerminalButton
          type="submit"
          disabled={busy}
          className="shrink-0 px-2 py-0.5 text-fg-dark disabled:opacity-50"
        >
          send ↵
        </TerminalButton>
      </form>

      <p
        role="note"
        aria-label="Privacy"
        className="-mt-4 text-xs leading-relaxed text-comment"
      >
        <span aria-hidden>{"// "}</span>
        {chatPrivacyNote}
      </p>

      <McpConnect mcpUrl={mcpUrl} />
    </div>
  );
}
