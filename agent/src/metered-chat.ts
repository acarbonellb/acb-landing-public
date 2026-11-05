// A chat run with its accounting: every model call's usage is charged to the
// request's spend reservation, and once the run ends, however it ends, the
// reservation is settled and the request is recorded for `/stats`. The chat
// events pass through unchanged.
import type { TokenUsage } from "../../src/shared/chat-contract";
import type { ChatAgent, ChatMessage, ChatRunEvent } from "./chat";
import { addUsage } from "./pricing";
import type { SpendReservation } from "./spend-cap";
import type { ChatOutcome, UsageRecorder } from "./usage";

export type MeteredChatOptions = {
  agent: ChatAgent;
  /** This request's reservation against the spend cap. */
  reservation: SpendReservation;
  usage: UsageRecorder;
  /** When the request arrived (`performance.now()`), for its latency. */
  startedAt: number;
  /** Aborts the model call. The run keeps draining: the cut-off call still reports its usage. */
  signal?: AbortSignal;
};

/**
 * Runs the chat and yields its events. Recording and settling are best
 * effort (they never throw), so a failure in one doesn't skip the other.
 */
export async function* meteredChat(
  messages: ChatMessage[],
  { agent, reservation, usage, startedAt, signal }: MeteredChatOptions,
): AsyncGenerator<ChatRunEvent> {
  const elapsed = () => Math.round(performance.now() - startedAt);
  // What `usage.ts` records once the run ends: no content. A run that never
  // reaches its end (the consumer stopped early) counts as aborted.
  let outcome: ChatOutcome = "aborted";
  let firstTextMs: number | undefined;
  const spent: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  try {
    for await (const event of agent.run(messages, { signal })) {
      if (event.type === "usage") {
        await reservation.record(event);
        addUsage(spent, event);
      }
      if (event.type === "text") firstTextMs ??= elapsed();
      if (event.type === "done") outcome = event.stopReason;
      if (event.type === "error") outcome = `error:${event.code}`;
      yield event;
    }
  } finally {
    await reservation.settle();
    await usage.recordChat({ outcome, usage: spent, totalMs: elapsed(), firstTextMs });
  }
}
