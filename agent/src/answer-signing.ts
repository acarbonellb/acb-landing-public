// Signed answers: the agent signs every answer it gives (an HMAC keyed by
// `ANSWER_SIGNING_KEY`) and accepts earlier answers back only with a valid
// signature, so a chat request can't put words in the agent's mouth while the
// server stays stateless (README, "Signed answers"; ADR 0004).
//
// Each signature binds the answer to its place: the conversation it was given
// in (a random id the conversation's first answer starts), its position there
// (1, 2, ...) and the question it answered. So a genuine answer can't come
// back after a question it didn't answer, before an answer it came after, or
// in another conversation. The id and position travel in the signature
// itself (`<conversation>.<position>.<mac>`), so nothing is kept between
// requests. Positions only have to grow: the site leaves out turns it can't
// send back (failed, empty) and, past the message cap, the oldest ones.
//
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
const domain = "acb-agent-answer:v2\n";

/** Where an answer sits: its conversation, its position there, and the question it answers. */
export type AnswerPlace = { conversation: string; position: number; question: string };

/** A chat request's conversation, checked: as the chat agent reads it, and where its answer goes. */
export type VerifiedConversation = { messages: ChatMessage[]; next: AnswerPlace };

export type AnswerSigner = {
  /** The signature of `answer`, over its text as it goes back in the conversation, at `place`. */
  sign(place: AnswerPlace, answer: string): string;
  /**
   * The conversation as the chat agent reads it (no signatures) and the place
   * of its answer, or `null` when an earlier answer is unsigned, its
   * signature doesn't match, or it is out of its place.
   */
  verify(messages: ReceivedMessage[]): VerifiedConversation | null;
  /** The run's events, with its `done` event signed over the answer it streamed, at `place`. */
  signEvents(place: AnswerPlace, events: AsyncIterable<ChatRunEvent>): AsyncGenerator<ChatEvent>;
};

const conversationId = /^[A-Za-z0-9_-]{22}$/;
const positionText = /^[1-9][0-9]{0,3}$/;

/** A fresh conversation id: 16 random bytes, base64url. */
const newConversation = () => randomBytes(16).toString("base64url");

/** The place a signature names, if it is well formed (its MAC is checked apart). */
function placeOf(signature: string): { conversation: string; position: number } | null {
  const [conversation, position, mac, ...rest] = signature.split(".");
  if (rest.length || !mac || !conversationId.test(conversation) || !positionText.test(position)) {
    return null;
  }
  return { conversation, position: Number(position) };
}

export function createAnswerSigner(key: string): AnswerSigner {
  const sign = ({ conversation, position, question }: AnswerPlace, answer: string) => {
    const mac = createHmac("sha256", key)
      .update(domain + JSON.stringify([conversation, position, question, answerForHistory(answer)]))
      .digest("base64url");
    return `${conversation}.${position}.${mac}`;
  };
  const matches = (expected: string, given: string) => {
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  return {
    sign,
    verify(messages) {
      const conversation: ChatMessage[] = [];
      let id: string | undefined;
      let position = 0;
      for (const m of messages) {
        if (m.role === "assistant") {
          const place = m.signature ? placeOf(m.signature) : null;
          const question = conversation.at(-1)?.content;
          if (!m.signature || !place || question === undefined) return null;
          if ((id !== undefined && place.conversation !== id) || place.position <= position) {
            return null;
          }
          if (!matches(sign({ ...place, question }, m.content), m.signature)) return null;
          id = place.conversation;
          position = place.position;
        }
        conversation.push({ role: m.role, content: m.content });
      }
      return {
        messages: conversation,
        next: {
          conversation: id ?? newConversation(),
          position: position + 1,
          question: conversation.at(-1)?.content ?? "",
        },
      };
    },
    async *signEvents(place, events) {
      let answer = "";
      for await (const event of events) {
        if (event.type === "text") answer += event.delta;
        yield event.type === "done" ? { ...event, signature: sign(place, answer) } : event;
      }
    },
  };
}

/** A key for one process, when none is configured outside production. */
export const ephemeralSigningKey = () => randomBytes(32).toString("base64url");
