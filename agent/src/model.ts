// The model-client seam. The chat loop only talks to this interface, never to
// a vendor SDK, so another provider (or a deterministic fake in tests) can be
// dropped in without touching the loop or the tools.

/** How hard the model thinks (and how many tokens it spends) per answer. */
export const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof efforts)[number];

/** A tool as the model sees it: name, description and a JSON Schema. */
export type ModelTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCall = { id: string; name: string; input: unknown };

export type ToolResult = { callId: string; output: string; isError: boolean };

/**
 * A call's input tokens. `inputTokens` is all of them; the cache fields say
 * how many of those were written to or read from the prompt cache, which are
 * priced differently (`pricing.ts`). Absent means none.
 */
export type InputUsage = {
  inputTokens: number;
  cacheWriteInputTokens?: number;
  cacheReadInputTokens?: number;
};

/** Tokens spent by one model call. */
export type Usage = InputUsage & { outputTokens: number };

/** Just the input part of `usage` (or of an `input_usage` event). */
export function inputOf(usage: InputUsage): InputUsage {
  const { inputTokens, cacheWriteInputTokens, cacheReadInputTokens } = usage;
  return {
    inputTokens,
    ...(cacheWriteInputTokens !== undefined && { cacheWriteInputTokens }),
    ...(cacheReadInputTokens !== undefined && { cacheReadInputTokens }),
  };
}

/**
 * Why the model stopped: it finished (`end_turn`), wants tools run
 * (`tool_use`), hit the per-request token cap (`max_tokens`), or declined
 * (`refusal`).
 */
export type ModelStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

/** One completed model call. */
export type ModelResponse = {
  text: string;
  toolCalls: ToolCall[];
  stopReason: ModelStopReason;
  usage: Usage;
  /**
   * The provider's raw assistant content, replayed verbatim on the next call
   * that answers the same turn (e.g. thinking blocks). Opaque to the loop.
   */
  providerContent?: unknown;
};

export type ModelMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls?: ToolCall[];
      providerContent?: unknown;
    }
  | { role: "tool_results"; results: ToolResult[] };

export type ModelRequest = {
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  /** Hard cap on output tokens for this call. */
  maxTokens: number;
  signal?: AbortSignal;
};

export type ModelStreamEvent =
  /**
   * Optional, before anything else: the call's input tokens as soon as the
   * provider reports them, so a call that never finishes can still be priced.
   */
  | ({ type: "input_usage" } & InputUsage)
  | { type: "text_delta"; text: string }
  | { type: "response_end"; response: ModelResponse };

export interface ModelClient {
  /**
   * Streams one model call: an optional `input_usage`, text deltas, then
   * exactly one `response_end`.
   */
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

/**
 * The model could not be reached or refused the request for capacity reasons
 * (overloaded, upstream rate limit, network: `capacity`), or because the
 * provider's own spend or credit limit was hit (`provider_limit`). Shown to
 * visitors as "unavailable"; anything else is an internal error.
 */
export class ModelUnavailableError extends Error {
  readonly reason: "capacity" | "provider_limit";

  constructor(message: string, options: ErrorOptions & { reason?: ModelUnavailableError["reason"] } = {}) {
    super(message, options);
    this.reason = options.reason ?? "capacity";
  }
}
