import type { Ref } from "react";
import type { Turn } from "@/lib/chat-session";
import type { ChatStopReason } from "@/shared/chat-contract";
import { ContactFallbackAnswer } from "./contact-fallback";
import { Markdown } from "./markdown";

// The agent's Markdown in the terminal palette. Long URLs wrap anywhere so
// they never push the page sideways on a phone.
const answerStyle =
  "min-w-0 flex-1 space-y-2 text-fg-dark [overflow-wrap:anywhere] [&_a]:text-blue [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-cyan [&_code]:text-yellow [&_em]:italic [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_strong]:font-bold [&_strong]:text-fg [&_ul]:list-['-_'] [&_ul]:pl-6";

const stopNotes: Partial<Record<ChatStopReason, string>> = {
  max_tokens: "[answer cut short by the length limit]",
  max_iterations: "[too many tool calls; try a narrower question]",
};

/** The conversation so far, as a scrolling log. */
export function ChatTranscript({
  turns,
  busy,
  linkedin,
  ref,
}: {
  turns: Turn[];
  busy: boolean;
  /** Where the contact fallback points when the MCP tools fail too. */
  linkedin: string;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
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
        <TurnView key={turn.id} turn={turn} linkedin={linkedin} />
      ))}
    </div>
  );
}

function TurnView({ turn, linkedin }: { turn: Turn; linkedin: string }) {
  const { status } = turn;
  const stopNote = status.kind === "answered" ? stopNotes[status.stopReason] : undefined;
  return (
    <div className="space-y-2">
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
          <div key={i} className="flex gap-[1ch]">
            <span className="shrink-0 text-magenta">agent ›</span>
            <div className={answerStyle}>
              <Markdown text={part.text.trim()} />
            </div>
          </div>
        ),
      )}
      {status.kind === "fallback" && (
        <ContactFallbackAnswer fallback={status.fallback} linkedin={linkedin} />
      )}
      {status.kind === "streaming" && (
        <p className="text-comment">
          <span className="text-magenta">agent ›</span> thinking…
        </p>
      )}
      {stopNote && <p className="text-comment">{stopNote}</p>}
    </div>
  );
}
