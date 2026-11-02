"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  type ChatClientEvent,
  type ChatErrorKind,
  type ChatMessage,
  streamChat,
} from "@/lib/chat-client";

// Limits from the chat endpoint contract (README, "Chat endpoint contract").
const MAX_MESSAGES = 20;
const MAX_CHARS = 2000;

type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; label: string };

type Turn = {
  id: number;
  question: string;
  parts: Part[];
  status: "streaming" | "done" | "failed";
  stopReason?: string;
};

type Notice = {
  kind: ChatErrorKind;
  message?: string;
  retryAfterSeconds?: number;
};

const noticeTitle: Record<ChatErrorKind, string> = {
  rate_limited: "Rate limit reached.",
  unavailable: "The agent is unavailable right now.",
  error: "Something went wrong.",
};

const noticeFallback: Record<ChatErrorKind, string> = {
  rate_limited: "Too many questions in a short time.",
  unavailable: "Please try again later.",
  error: "Please try again.",
};

const stopNotes: Record<string, string> = {
  max_tokens: "[answer cut short by the length limit]",
  max_iterations: "[too many tool calls; try a narrower question]",
};

function toolLabel(name: string, input: unknown): string {
  const isEmpty =
    input == null ||
    (typeof input === "object" && Object.keys(input).length === 0);
  return `${name}(${isEmpty ? "" : JSON.stringify(input)})`;
}

function answerText(turn: Turn): string {
  return turn.parts
    .map((p) => (p.kind === "text" ? p.text : ""))
    .join("")
    .trim();
}

// The conversation the endpoint sees: completed exchanges with an answer,
// most recent first to survive the message cap, then the new question.
function historyFor(turns: Turn[], question: string): ChatMessage[] {
  const pairs = turns
    .filter((t) => t.status === "done" && answerText(t))
    .slice(-Math.floor((MAX_MESSAGES - 1) / 2));
  return [
    ...pairs.flatMap((t): ChatMessage[] => [
      { role: "user", content: t.question },
      { role: "assistant", content: answerText(t).slice(0, MAX_CHARS) },
    ]),
    { role: "user", content: question },
  ];
}

function applyEvent(turn: Turn, event: ChatClientEvent): Turn {
  switch (event.type) {
    case "text": {
      const last = turn.parts.at(-1);
      const parts =
        last?.kind === "text"
          ? [...turn.parts.slice(0, -1), { ...last, text: last.text + event.delta }]
          : [...turn.parts, { kind: "text" as const, text: event.delta }];
      return { ...turn, parts };
    }
    case "tool_call":
      return {
        ...turn,
        parts: [
          ...turn.parts,
          { kind: "tool", id: event.id, label: toolLabel(event.name, event.input) },
        ],
      };
    case "done":
      return { ...turn, status: "done", stopReason: event.stopReason };
    case "error":
      return { ...turn, status: "failed" };
  }
}

export function AgentChat({
  chatUrl,
  mcpUrl,
  fetch,
}: {
  chatUrl: string;
  mcpUrl: string;
  fetch?: typeof globalThis.fetch;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const inputId = useId();
  const busy = turns.at(-1)?.status === "streaming";
  const command = `claude mcp add --transport http albertocarbonell ${mcpUrl}`;

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const question = draft.trim();
    if (!question || busy) return;

    const id = nextId.current++;
    const messages = historyFor(turns, question);
    const update = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));

    setDraft("");
    setNotice(null);
    setTurns((all) => [...all, { id, question, parts: [], status: "streaming" }]);

    const controller = new AbortController();
    abort.current = controller;
    for await (const event of streamChat(chatUrl, messages, {
      fetch,
      signal: controller.signal,
    })) {
      update((t) => applyEvent(t, event));
      if (event.type === "error") {
        setNotice({
          kind: event.kind,
          message: event.message,
          retryAfterSeconds: event.retryAfterSeconds,
        });
      }
    }
    // Aborted mid-stream (e.g. unmount): leave nothing spinning.
    update((t) => (t.status === "streaming" ? { ...t, status: "failed" } : t));
  }

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
    <div className="space-y-6">
      <div
        ref={logRef}
        role="log"
        aria-label="Conversation with the agent"
        aria-busy={busy}
        tabIndex={0}
        className="max-h-[28rem] space-y-3 overflow-y-auto text-sm leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-blue"
      >
        <p>
          <span className="text-comment">[system]</span>{" "}
          <span className="text-fg-dark">
            An agent that answers questions about my experience and projects.
            Try &ldquo;What have you built with agents?&rdquo;
          </span>
        </p>
        {turns.map((turn) => (
          <div key={turn.id} className="space-y-2">
            <p className="break-words whitespace-pre-wrap">
              <span className="text-cyan">you ›</span>{" "}
              <span className="text-fg">{turn.question}</span>
            </p>
            {turn.parts.map((part, i) =>
              part.kind === "tool" ? (
                <p key={part.id} className="break-words text-fg-dark">
                  <span className="text-magenta">agent ›</span> calling{" "}
                  <code className="text-yellow">{part.label}</code>
                </p>
              ) : (
                <p key={i} className="break-words whitespace-pre-wrap">
                  <span className="text-magenta">agent ›</span>{" "}
                  <span className="text-fg-dark">{part.text.trim()}</span>
                </p>
              ),
            )}
            {turn.status === "streaming" && (
              <p className="text-comment">
                <span className="text-magenta">agent ›</span> thinking…
              </p>
            )}
            {turn.stopReason && stopNotes[turn.stopReason] && (
              <p className="text-comment">{stopNotes[turn.stopReason]}</p>
            )}
          </div>
        ))}
      </div>

      {notice && (
        <div
          role="alert"
          className={`rounded border px-3 py-2 text-sm text-fg ${
            notice.kind === "rate_limited"
              ? "border-yellow"
              : notice.kind === "unavailable"
                ? "border-orange"
                : "border-red"
          }`}
        >
          <p className="font-bold">{noticeTitle[notice.kind]}</p>
          <p className="text-fg-dark">
            {notice.message ?? noticeFallback[notice.kind]}
            {notice.retryAfterSeconds !== undefined &&
              ` Try again in ${notice.retryAfterSeconds}s.`}
          </p>
        </div>
      )}

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
          id={inputId}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={MAX_CHARS}
          autoComplete="off"
          placeholder="ask about my experience, projects, stack…"
          className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-comment"
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-fg-dark transition-colors hover:border-blue hover:text-blue focus-visible:border-blue focus-visible:text-blue disabled:opacity-50"
        >
          send ↵
        </button>
      </form>

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
          <button
            type="button"
            onClick={copyCommand}
            className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-fg-dark transition-colors hover:border-blue hover:text-blue focus-visible:border-blue focus-visible:text-blue"
          >
            {copied ? "copied" : "copy"}
            <span className="sr-only"> MCP command</span>
          </button>
        </div>
      </div>
    </div>
  );
}
