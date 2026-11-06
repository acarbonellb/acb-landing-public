// The wire contract of the agent's `POST /chat` endpoint (README, "Chat
// endpoint contract"): request limits, message and event shapes, error codes.
// Both sides import this one module: the site's chat client and UI, and the
// agent service (`agent/`, which bundles it like `src/shared/profile.ts`).
// Types, plain constants and pure functions only, so it is safe in either
// runtime.

/** Limits on the conversation a chat request may carry. */
export const chatRequestLimits = {
  /** Messages per request (history plus the new question). */
  maxMessages: 20,
  /** Characters per message. */
  maxMessageChars: 2000,
} as const;

export type ChatRole = "user" | "assistant";

/** One message of the conversation, as the agent reads it. */
export type ChatMessage = { role: ChatRole; content: string };

/**
 * An earlier answer sent back with the conversation, with the `signature` its
 * `done` event carried. The agent refuses a chat request whose earlier answers
 * are unsigned, were changed or were moved (README, "Signed answers").
 */
export type SignedAnswer = { role: "assistant"; content: string; signature: string };

/** One message of the conversation the browser sends. */
export type ChatRequestMessage = { role: "user"; content: string } | SignedAnswer;

/** The request body: alternating messages, starting and ending with `user`. */
export type ChatRequest = { messages: ChatRequestMessage[] };

/**
 * An answer's text as it goes back in the conversation, and as the agent signs
 * it: trimmed and cut to the message limit (then trimmed again, so the
 * agent's own trimming of what it receives can't change it).
 */
export function answerForHistory(text: string): string {
  return text.trim().slice(0, chatRequestLimits.maxMessageChars).trim();
}

/**
 * Tokens spent by model calls. `inputTokens` counts all input; the optional
 * cache fields say how much of it was written to or read from the prompt
 * cache (absent: none).
 */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteInputTokens?: number;
  cacheReadInputTokens?: number;
};

/**
 * Why the answer to a chat request ended: answered (`end_turn`), cut by a token cap
 * (`max_tokens`), cut by the model-call cap (`max_iterations`), or the model
 * declined (`refusal`).
 */
export type ChatStopReason = "end_turn" | "max_tokens" | "max_iterations" | "refusal";

/** Codes of the `error` event that can end a stream. */
export type ChatErrorCode = "unavailable" | "internal";

/** One server-sent event of the chat stream (`event: <type>`, `data: <JSON>`). */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      isError: boolean;
      output: unknown;
    }
  | ({
      type: "usage";
      /** Which model call of the request this is, counting from 1. */
      iteration: number;
      /** Set when the call never reported its usage and this is an upper bound. */
      estimated?: true;
    } & TokenUsage)
  | {
      type: "done";
      stopReason: ChatStopReason;
      usage: TokenUsage;
      /** The answer's signature, to send back with it (`SignedAnswer`). */
      signature: string;
    }
  | { type: "error"; code: ChatErrorCode; message: string };

/** Codes of the JSON errors answered before any streaming. */
export type HttpErrorCode = "invalid_request" | "rate_limited" | "unavailable";

/**
 * Body of every non-streamed chat error. `rate_limited` adds
 * `retryAfterSeconds` (also sent as the `Retry-After` header), and `resetsAt`
 * (the next UTC midnight) when the key's daily quota refused it; `unavailable`
 * because of the monthly spend cap adds `resetsAt` (ISO time the spend cap
 * renews). `message` is user-facing and safe to show as-is.
 */
export type HttpErrorBody = {
  error: {
    code: HttpErrorCode;
    message: string;
    retryAfterSeconds?: number;
    resetsAt?: string;
  };
};
