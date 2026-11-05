import { useEffect, useRef, useState } from "react";
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

/**
 * A conversation with the agent's chat endpoint: the turns so far, the notice
 * of a failed question, whether an answer is streaming, and `ask`. With a
 * `fallback`, a failed question is answered by it instead of a notice.
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

  useEffect(() => () => abort.current?.abort(), []);

  async function ask(question: string, { fallback }: { fallback?: FallbackStrategy } = {}) {
    const id = nextId.current++;
    const messages = historyFor(turns, question);
    const update = (fn: (t: Turn) => Turn) =>
      setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));

    setTurns((all) => [...all, startTurn(id, question)]);

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
  }

  return { turns, notice: noticeOf(turns), busy: isBusy(turns), ask };
}
