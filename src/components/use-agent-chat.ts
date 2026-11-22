import { useEffect, useRef, useState } from "react";
import { type QuestionSource, report } from "@/lib/analytics";
import { type ChatErrorKind, streamChat } from "@/lib/chat-client";
import {
  type Turn,
  answerWithFallback,
  endTurn,
  foldEvent,
  historyFor,
  isBusy,
  noticeOf,
  outcomeOf,
  startTurn,
} from "@/lib/chat-session";
import type { FallbackStrategy } from "@/lib/contact-fallback";

/**
 * A conversation with the agent's chat endpoint: the turns so far, the notice
 * of a failed question, whether an answer is streaming, and `ask`. With a
 * `fallback`, a failed question is answered by it instead of a notice.
 * Each question is reported to site analytics when sent and when it ends,
 * with its `source` (docs/analytics.md#events).
 */
export function useAgentChat({
  chatUrl,
  fetch,
}: {
  chatUrl: string;
  fetch?: typeof globalThis.fetch;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  /** The question in flight, until its "ended" event is reported. */
  const inFlight = useRef<{ source: QuestionSource; sentAt: number } | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  // A visitor who leaves while an answer streams abandoned the question.
  useEffect(() => {
    const leave = () => {
      const question = inFlight.current;
      if (!question) return;
      inFlight.current = null;
      report(ended(question, "abandoned"), { leaving: true });
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, []);

  async function ask(
    question: string,
    { fallback, source = "input" }: { fallback?: FallbackStrategy; source?: QuestionSource } = {},
  ) {
    const id = nextId.current++;
    const messages = historyFor(turns, question);
    let last = startTurn(id, question);
    const update = (fn: (t: Turn) => Turn) => {
      last = fn(last);
      setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));
    };

    setTurns((all) => [...all, last]);
    const sent = { source, sentAt: performance.now() };
    inFlight.current = sent;
    report({ event: "chat_question_sent", properties: { source } });

    const controller = new AbortController();
    abort.current = controller;
    let failure: ChatErrorKind | undefined;
    for await (const event of streamChat(chatUrl, messages, {
      fetch,
      signal: controller.signal,
    })) {
      if (event.type === "error" && fallback) {
        failure = event.kind;
        break;
      }
      update((t) => foldEvent(t, event));
    }
    if (failure && fallback) {
      // Still streaming while the fallback answers.
      const answer = await fallback(failure, controller.signal);
      update((t) => answerWithFallback(t, answer));
    }
    update(endTurn);
    if (inFlight.current === sent) {
      inFlight.current = null;
      report(ended(sent, outcomeOf(last)));
    }
  }

  return { turns, notice: noticeOf(turns), busy: isBusy(turns), ask };
}

const ended = (
  { source, sentAt }: { source: QuestionSource; sentAt: number },
  outcome: ReturnType<typeof outcomeOf>,
) =>
  ({
    event: "chat_question_ended",
    properties: { source, outcome, ms: Math.round(performance.now() - sentAt) },
  }) as const;
