// The chat's conversation state, as pure functions over a list of turns: how
// chat events fold into a turn, which notice the conversation shows, and the
// history sent with the next question. The `useAgentChat` hook holds the list
// and runs the requests; the views only render it.
import type { ChatClientEvent, ChatErrorKind } from "./chat-client";
import type { ContactFallback } from "./contact-fallback";
import {
  answerForHistory,
  type ChatRequestMessage,
  type ChatStopReason,
  chatRequestLimits,
} from "@/shared/chat-contract";

const { maxMessages } = chatRequestLimits;

/** One piece of an answer, in the order it streamed. */
export type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; label: string };

/** What the chat shows when a question fails. */
export type Notice = {
  kind: ChatErrorKind;
  message?: string;
  retryAfterSeconds?: number;
  /** ISO time the spend cap resets (next UTC month), when it closed the chat. */
  resetsAt?: string;
};

export type TurnStatus =
  | { kind: "streaming" }
  /** `signature` goes back with the answer in the next chat request. */
  | { kind: "answered"; stopReason: ChatStopReason; signature?: string }
  /** The notice is absent when the request was aborted (e.g. on unmount). */
  | { kind: "failed"; notice?: Notice }
  | { kind: "fallback"; fallback: ContactFallback };

/** One question and its answer. */
export type Turn = {
  id: number;
  question: string;
  parts: Part[];
  status: TurnStatus;
};

export function startTurn(id: number, question: string): Turn {
  return { id, question, parts: [], status: { kind: "streaming" } };
}

function toolLabel(name: string, input: unknown): string {
  const isEmpty =
    input == null ||
    (typeof input === "object" && Object.keys(input).length === 0);
  return `${name}(${isEmpty ? "" : JSON.stringify(input)})`;
}

export function foldEvent(turn: Turn, event: ChatClientEvent): Turn {
  switch (event.type) {
    case "text": {
      const last = turn.parts.at(-1);
      const parts: Part[] =
        last?.kind === "text"
          ? [...turn.parts.slice(0, -1), { ...last, text: last.text + event.delta }]
          : [...turn.parts, { kind: "text", text: event.delta }];
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
    case "done": {
      const status: TurnStatus = { kind: "answered", stopReason: event.stopReason };
      if (event.signature !== undefined) status.signature = event.signature;
      return { ...turn, status };
    }
    case "error": {
      const { kind, message, retryAfterSeconds, resetsAt } = event;
      const notice: Notice = { kind };
      if (message !== undefined) notice.message = message;
      if (retryAfterSeconds !== undefined) notice.retryAfterSeconds = retryAfterSeconds;
      if (resetsAt !== undefined) notice.resetsAt = resetsAt;
      return { ...turn, status: { kind: "failed", notice } };
    }
  }
}

export function answerWithFallback(turn: Turn, fallback: ContactFallback): Turn {
  return { ...turn, status: { kind: "fallback", fallback } };
}

/** Once the request is over: a turn still streaming was aborted. */
export function endTurn(turn: Turn): Turn {
  return turn.status.kind === "streaming"
    ? { ...turn, status: { kind: "failed" } }
    : turn;
}

/** The notice of the last question, when it failed with one. */
export function noticeOf(turns: Turn[]): Notice | null {
  const status = turns.at(-1)?.status;
  return (status?.kind === "failed" && status.notice) || null;
}

export function isBusy(turns: Turn[]): boolean {
  return turns.at(-1)?.status.kind === "streaming";
}

/** A turn's answer as it goes back to the agent, with its signature, if it can. */
function signedAnswer(turn: Turn): ChatRequestMessage | undefined {
  if (turn.status.kind !== "answered" || !turn.status.signature) return undefined;
  const content = answerForHistory(
    turn.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""),
  );
  return content ? { role: "assistant", content, signature: turn.status.signature } : undefined;
}

/**
 * The conversation the endpoint sees: turns the chat answered with signed
 * text (the agent refuses any other answer), most recent first to survive
 * the message cap, then the new question.
 */
export function historyFor(turns: Turn[], question: string): ChatRequestMessage[] {
  const pairs = turns
    .flatMap((t) => {
      const answer = signedAnswer(t);
      return answer ? [[{ role: "user", content: t.question }, answer] as const] : [];
    })
    .slice(-Math.floor((maxMessages - 1) / 2));
  return [...pairs.flat(), { role: "user", content: question }];
}
