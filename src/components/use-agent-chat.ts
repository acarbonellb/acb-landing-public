import { type RefObject, useEffect, useRef, useState } from "react";
import { type QuestionOutcome, type QuestionSource, outcomeOf, report } from "@/lib/analytics";
import { type ChatErrorKind, streamChat } from "@/lib/chat-client";
import {
  type Turn,
  answerWithFallback,
  endTurn,
  foldEvent,
  historyFor,
  isBusy,
  noticeOf,
  startTurn,
} from "@/lib/chat-session";
import type { FallbackStrategy } from "@/lib/contact-fallback";

/** A question sent and not yet reported ended. */
type SentQuestion = { source: QuestionSource; sentAt: number };

/**
 * A conversation with the agent's chat endpoint: the turns so far, the notice
 * of a failed question, whether an answer is streaming, and `ask`. With a
 * `fallback`, a failed question is answered by it instead of a notice.
 * Each question is reported to site analytics when sent and, exactly once,
 * when it ends, with its `source` (docs/analytics.md#events): with how it
 * ended, `error` if asking threw, or `abandoned` if the visitor left or the
 * chat went away first.
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
  const inFlight = useRef<SentQuestion | null>(null);

  useEffect(() => {
    // A visitor who leaves, or a chat that goes away, while an answer
    // streams abandoned the question.
    const leave = (options?: { leaving: boolean }) =>
      reportEnded(inFlight, inFlight.current, "abandoned", options);
    const onPageHide = () => leave({ leaving: true });
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      leave();
      abort.current?.abort();
    };
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
    const sent: SentQuestion = { source, sentAt: performance.now() };
    inFlight.current = sent;
    report({ event: "chat_question_sent", properties: { source } });

    // Until the request settles, asking threw.
    let outcome: QuestionOutcome = "error";
    try {
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
      outcome = outcomeOf(endTurn(last));
    } finally {
      update(endTurn);
      reportEnded(inFlight, sent, outcome);
    }
  }

  return { turns, notice: noticeOf(turns), busy: isBusy(turns), ask };
}

/** Reports `question` ended, unless it no longer is the one in flight (already reported). */
function reportEnded(
  inFlight: RefObject<SentQuestion | null>,
  question: SentQuestion | null,
  outcome: QuestionOutcome,
  options?: { leaving: boolean },
) {
  if (!question || inFlight.current !== question) return;
  inFlight.current = null;
  const ms = Math.round(performance.now() - question.sentAt);
  report(
    { event: "chat_question_ended", properties: { source: question.source, outcome, ms } },
    options,
  );
}
