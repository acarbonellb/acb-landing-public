// Production model client: Claude through the official Anthropic SDK. The
// only file that knows about the vendor; everything else uses `ModelClient`.
import Anthropic from "@anthropic-ai/sdk";
import {
  ModelUnavailableError,
  type ModelClient,
  type ModelMessage,
  type ModelStopReason,
  type ModelTurn,
} from "./model";

export const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof efforts)[number];

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const fallbackModels = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

export type AnthropicModelOptions = {
  apiKey: string;
  model: string;
  /** Thinking depth / token spend. Short, grounded answers do well on `low`. */
  effort: Effort;
  /** Test seam: a canned `fetch` so tests never reach the API. */
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
};

type Params = Anthropic.Beta.Messages.MessageCreateParamsStreaming;

function toParams(messages: ModelMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m): Anthropic.Beta.BetaMessageParam => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.text };
      case "assistant":
        if (m.providerContent) {
          // Same-turn replay: blocks (thinking included) go back unchanged.
          return {
            role: "assistant",
            content: m.providerContent as Anthropic.Beta.BetaContentBlockParam[],
          };
        }
        return {
          role: "assistant",
          content: [
            ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
            ...(m.toolCalls ?? []).map((call) => ({
              type: "tool_use" as const,
              id: call.id,
              name: call.name,
              input: call.input,
            })),
          ],
        };
      case "tool_results":
        return {
          role: "user",
          content: m.results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.callId,
            content: r.output,
            is_error: r.isError,
          })),
        };
    }
  });
}

function stopReason(reason: Anthropic.Beta.BetaStopReason | null): ModelStopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

function toTurn(message: Anthropic.Beta.BetaMessage): ModelTurn {
  const { usage } = message;
  return {
    text: message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    toolCalls: message.content.flatMap((b) =>
      b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
    ),
    stopReason: stopReason(message.stop_reason),
    usage: {
      // Cached input is counted as input: an upper bound for spend tracking.
      inputTokens:
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
    },
    providerContent: message.content,
  };
}

/** Capacity and network failures are "try again later", not bugs. */
function isUnavailable(error: unknown): boolean {
  return (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  );
}

export function createAnthropicModelClient(options: AnthropicModelOptions): ModelClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    fetch: options.fetch,
    maxRetries: options.maxRetries,
  });
  const fallbacks = fallbackModels.has(options.model);

  return {
    async *stream(request) {
      const params: Params = {
        model: options.model,
        max_tokens: request.maxTokens,
        stream: true,
        system: request.system,
        // Tool inputs here are tiny (one optional filter), so eager input
        // streaming would buy nothing; the toolset validates every input.
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
        })),
        messages: toParams(request.messages),
        output_config: { effort: options.effort },
        // System prompt and tools never change: cache that prefix.
        cache_control: { type: "ephemeral" },
        ...(fallbacks && {
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default" as const,
        }),
      };
      try {
        const stream = client.beta.messages.stream(params, { signal: request.signal });
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          }
        }
        yield { type: "turn_end", turn: toTurn(await stream.finalMessage()) };
      } catch (error) {
        if (isUnavailable(error)) {
          throw new ModelUnavailableError("Claude is unavailable", { cause: error });
        }
        throw error;
      }
    },
  };
}
