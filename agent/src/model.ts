// The model-client seam. The chat loop only talks to this interface, never to
// a vendor SDK, so another provider (or a deterministic fake in tests) can be
// dropped in without touching the loop or the tools.

/** A tool as the model sees it: name, description and a JSON Schema. */
export type ModelTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCall = { id: string; name: string; input: unknown };

export type ToolResult = { callId: string; output: string; isError: boolean };

/** Tokens spent by one model call. */
export type Usage = { inputTokens: number; outputTokens: number };

/**
 * Why the model stopped: it finished (`end_turn`), wants tools run
 * (`tool_use`), hit the per-request token cap (`max_tokens`), or declined
 * (`refusal`).
 */
export type ModelStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

/** One completed model call. */
export type ModelTurn = {
  text: string;
  toolCalls: ToolCall[];
  stopReason: ModelStopReason;
  usage: Usage;
  /**
   * The provider's raw assistant content, replayed verbatim on the next call
   * of the same turn (e.g. thinking blocks). Opaque to the loop.
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
  | { type: "text_delta"; text: string }
  | { type: "turn_end"; turn: ModelTurn };

export interface ModelClient {
  /** Streams one model call: text deltas, then exactly one `turn_end`. */
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

/**
 * The model could not be reached or refused the request for capacity reasons
 * (overloaded, upstream rate limit, network). Shown to visitors as
 * "unavailable"; anything else is an internal error.
 */
export class ModelUnavailableError extends Error {}
