// Signed answers: the agent signs every answer it gives (an HMAC of its text,
// keyed by `ANSWER_SIGNING_KEY`) and accepts earlier answers back only with a
// valid signature, so a chat request can't put words in the agent's mouth
// while the server stays stateless (README, "Signed answers"; ADR 0004).
// Only the HTTP layer signs and checks: the chat agent, and the eval runner
// that calls it directly, never see a signature.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  answerForHistory,
  type ChatEvent,
  type ChatMessage,
} from "../../src/shared/chat-contract";
import type { ChatRunEvent, ReceivedMessage } from "./chat";

/** Versions what is signed, so a future scheme can't collide with this one. */
const domain = "acb-agent-answer:v1\n";

export type AnswerSigner = {
  /** The signature of an answer, over its text as it goes back in the conversation. */
  sign(answer: string): string;
  /**
   * The conversation as the chat agent reads it (no signatures), or `null`
   * when an earlier answer is unsigned or its signature doesn't match.
   */
  verify(messages: ReceivedMessage[]): ChatMessage[] | null;
  /** The run's events, with its `done` event signed over the answer it streamed. */
  signEvents(events: AsyncIterable<ChatRunEvent>): AsyncGenerator<ChatEvent>;
};

export function createAnswerSigner(key: string): AnswerSigner {
  const sign = (answer: string) =>
    createHmac("sha256", key)
      .update(domain + answerForHistory(answer))
      .digest("base64url");
  const matches = (answer: string, signature: string) => {
    const expected = Buffer.from(sign(answer));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  return {
    sign,
    verify(messages) {
      const conversation: ChatMessage[] = [];
      for (const m of messages) {
        if (m.role === "assistant" && !(m.signature && matches(m.content, m.signature))) {
          return null;
        }
        conversation.push({ role: m.role, content: m.content });
      }
      return conversation;
    },
    async *signEvents(events) {
      let answer = "";
      for await (const event of events) {
        if (event.type === "text") answer += event.delta;
        yield event.type === "done" ? { ...event, signature: sign(answer) } : event;
      }
    },
  };
}

/** A key for one process, when none is configured outside production. */
export const ephemeralSigningKey = () => randomBytes(32).toString("base64url");
