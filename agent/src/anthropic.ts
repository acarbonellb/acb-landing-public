// Production model client: Claude through the official Anthropic SDK. The
// only file that knows about the vendor; everything else uses `ModelClient`.
import Anthropic from "@anthropic-ai/sdk";
import {
  ModelUnavailableError,
  type Effort,
  type InputUsage,
  type ModelClient,
  type ModelMessage,
  type ModelStopReason,
  type ModelResponse,
} from "./model";
import { serverSideFallbackModels } from "./pricing";


export type AnthropicModelOptions = {
  apiKey: string;
  model: string;
  /** Thinking depth / token spend. Short, grounded answers do well on `low`. */
  effort: Effort;
  /**
   * Another Anthropic-compatible server, e.g. LM Studio for the evals.
   * Defaults to `ANTHROPIC_BASE_URL` or the Anthropic API.
   */
  baseURL?: string;
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

/**
 * All input tokens, cached ones included, with the cache writes and reads
 * among them reported apart: they are priced differently (`pricing.ts`).
 */
function inputUsage(usage: Anthropic.Beta.BetaUsage): InputUsage {
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens + written + read,
    ...(written > 0 && { cacheWriteInputTokens: written }),
    ...(read > 0 && { cacheReadInputTokens: read }),
  };
}

function toResponse(message: Anthropic.Beta.BetaMessage): ModelResponse {
  const { usage } = message;
  return {
    text: message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
    toolCalls: message.content.flatMap((b) =>
      b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [],
    ),
    stopReason: stopReason(message.stop_reason),
    usage: { ...inputUsage(usage), outputTokens: usage.output_tokens },
    providerContent: message.content,
  };
}

// A spend limit set on the workspace or organization answers 400
// `invalid_request_error`, told apart from a bad request only by this message
// prefix (docs: "Rate limits" > "Setting your own spend limit").
const spendLimitMessage = /^You have reached your specified (workspace )?API usage limits/;

function upstreamMessage(error: InstanceType<typeof Anthropic.APIError>): unknown {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  return body?.error?.message;
}

/**
 * Capacity, network and the provider's own limits are "try again later", not
 * bugs. The tier spend cap is a 429, covered by `RateLimitError`; no credit is
 * a 402 `billing_error`. Overload and rate limits also count when streamed.
 */
function isUnavailable(error: unknown): boolean {
  if (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  ) {
    return true;
  }
  if (!(error instanceof Anthropic.APIError)) return false;
  if (error.status === 402 || error.type === "billing_error") return true;
  // Mid-stream, after a 200, an SSE `error` event comes through as a plain
  // APIError with no status: only the body's error type says what it was.
  if (error.type === "overloaded_error" || error.type === "rate_limit_error") return true;
  const message = upstreamMessage(error);
  return (
    error instanceof Anthropic.BadRequestError &&
    typeof message === "string" &&
    spendLimitMessage.test(message)
  );
}

export function createAnthropicModelClient(options: AnthropicModelOptions): ModelClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    fetch: options.fetch,
    maxRetries: options.maxRetries,
  });
  const fallbacks = serverSideFallbackModels.has(options.model);

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
          if (event.type === "message_start") {
            yield { type: "input_usage", ...inputUsage(event.message.usage) };
          } else if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield { type: "text_delta", text: event.delta.text };
          }
        }
        yield { type: "response_end", response: toResponse(await stream.finalMessage()) };
      } catch (error) {
        if (isUnavailable(error)) {
          throw new ModelUnavailableError("Claude is unavailable", { cause: error });
        }
        throw error;
      }
    },
  };
}
