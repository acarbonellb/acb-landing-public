// The chat agent: built once from the model, toolset, limits and system
// prompt (`system-prompt.ts`), it estimates a request's worst-case usage and
// runs the tool-use loop: ask the model, run the tools it calls, feed the
// results back, repeat until it answers. Yields provider-neutral events that
// the HTTP layer streams to the browser as-is.
import * as z from "zod";
import {
  chatRequestLimits,
  type ChatErrorCode,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type ChatStopReason,
} from "../../src/shared/chat-contract";
import {
  inputOf,
  ModelUnavailableError,
  type InputUsage,
  type ModelClient,
  type ModelMessage,
  type ModelTool,
  type ToolResult,
  type Usage,
} from "./model";
import { describeError, logEvent } from "./log";
import { addUsage } from "./pricing";
import { systemPrompt } from "./system-prompt";
import { ToolInputError, type Toolset } from "./tools";

// The wire contract lives in one module shared with the site.
export type { ChatErrorCode, ChatEvent, ChatMessage, ChatStopReason };

export const chatLimits = {
  ...chatRequestLimits,
  /** Most model calls in one chat request (each one after the first reads tool results). */
  maxModelCalls: 5,
  /** Output-token cap per model call (thinking included). */
  maxTokens: 4096,
  /**
   * Output-token budget for the whole request, shared by all its model calls:
   * each call gets min(maxTokens, what's left).
   */
  maxRequestTokens: 8192,
};

/** What the browser sends: the visible conversation, ending with the new question. */
export const chatRequestSchema: z.ZodType<ChatRequest> = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().trim().min(1).max(chatLimits.maxMessageChars),
          })
          .strict(),
      )
      .min(1)
      .max(chatLimits.maxMessages)
      .refine((m) => m[0]?.role === "user", "The first message must be from the user")
      .refine((m) => m.at(-1)?.role === "user", "The last message must be from the user")
      .refine(
        (m) => m.every((msg, i) => i === 0 || msg.role !== m[i - 1].role),
        "Messages must alternate between user and assistant",
      ),
  })
  .strict();

/** The run limits of one chat request; `chatLimits` holds the defaults. */
export type ChatLimits = Pick<typeof chatLimits, "maxModelCalls" | "maxTokens" | "maxRequestTokens">;

export type ChatAgentOptions = {
  model: ModelClient;
  toolset: Toolset;
  /** Each limit left out takes its `chatLimits` default. */
  limits?: Partial<ChatLimits>;
  /** Defaults to the shipped `systemPrompt`; the evals swap it to prove staleness. */
  system?: string;
};

/**
 * One configured chat agent: its estimate and its run share the same model,
 * toolset, limits and system prompt, so they can't disagree.
 */
export type ChatAgent = {
  /**
   * The most one request can spend, reserved against the spend cap before it
   * runs (`spend-cap.ts`). Output is exact: the request's token budget. Input
   * is an estimate: every call re-reads the system prompt, tools and
   * conversation (counted generously at 2 characters per token) plus all
   * output so far; tool results ride on that margin. Actual usage is charged
   * afterwards either way.
   */
  worstCaseUsage(messages: ChatMessage[]): Usage;
  /** Answers the conversation, ending with its new question, as chat events. */
  run(messages: ChatMessage[], options?: { signal?: AbortSignal }): AsyncGenerator<ChatEvent>;
};

export function createChatAgent({
  model,
  toolset,
  limits = {},
  system = systemPrompt,
}: ChatAgentOptions): ChatAgent {
  const resolved: ChatLimits = {
    maxModelCalls: limits.maxModelCalls ?? chatLimits.maxModelCalls,
    maxTokens: limits.maxTokens ?? chatLimits.maxTokens,
    maxRequestTokens: limits.maxRequestTokens ?? chatLimits.maxRequestTokens,
  };
  const tools = modelTools(toolset);
  const fixedPromptChars = system.length + JSON.stringify(tools).length;
  return {
    worstCaseUsage(messages) {
      const promptChars =
        fixedPromptChars + messages.reduce((sum, m) => sum + m.content.length, 0);
      const perCallInput = Math.ceil(promptChars / 2) + resolved.maxRequestTokens;
      return {
        inputTokens: resolved.maxModelCalls * perCallInput,
        outputTokens: resolved.maxRequestTokens,
      };
    },
    run(messages, { signal } = {}) {
      return runChat({ model, toolset, tools, system, ...resolved, messages, signal });
    },
  };
}

export const refusalText =
  "Sorry, I can't help with that. I can tell you about Alberto's experience, projects, stack or how to contact him.";

/** User-facing messages of the stream's `error` events, safe to show as-is. */
export const errorMessages: Record<ChatErrorCode, string> = {
  unavailable: "The agent is unavailable right now. Please try again in a minute.",
  internal: "Something went wrong on my side. Please try again.",
};

/** The tools as the model sees them. */
export function modelTools(toolset: Toolset): ModelTool[] {
  return toolset.list().map((tool) => {
    const inputSchema: Record<string, unknown> = z.toJSONSchema(tool.inputSchema);
    delete inputSchema.$schema;
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

/** One run of the loop, with everything the agent resolved once. */
type ChatRun = ChatLimits & {
  model: ModelClient;
  toolset: Toolset;
  tools: ModelTool[];
  system: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
};

async function* runChat(options: ChatRun): AsyncGenerator<ChatEvent> {
  const { model, toolset, tools, system, maxModelCalls, maxTokens, maxRequestTokens, signal } =
    options;
  const messages: ModelMessage[] = options.messages.map((m) =>
    m.role === "user"
      ? { role: "user", text: m.content }
      : { role: "assistant", text: m.content },
  );
  const total: Usage = { inputTokens: 0, outputTokens: 0 };
  // The model call in progress, to price it if it never reports its usage.
  let inFlight:
    | { callNumber: number; maxTokens: number; input?: InputUsage }
    | undefined;
  let lastInputTokens = 0;

  try {
    for (let callNumber = 1; ; callNumber++) {
      let response;
      let streamed = false;
      const call = {
        callNumber,
        maxTokens: Math.min(maxTokens, maxRequestTokens - total.outputTokens),
      };
      inFlight = call;
      for await (const event of model.stream({
        system,
        messages,
        tools,
        maxTokens: call.maxTokens,
        signal,
      })) {
        if (event.type === "input_usage") {
          inFlight.input = inputOf(event);
        } else if (event.type === "text_delta") {
          streamed = true;
          yield { type: "text", delta: event.text };
        } else {
          response = event.response;
        }
      }
      inFlight = undefined;
      if (!response) throw new Error("Model stream ended without a response");

      lastInputTokens = response.usage.inputTokens;
      addUsage(total, response.usage);
      // Tool events of this call come before its usage, so the browser sees
      // them as soon as they run.
      const wantsTools = response.stopReason === "tool_use" && response.toolCalls.length > 0;
      // Running tools needs another model call to read their results.
      const budgetLeft = total.outputTokens < maxRequestTokens;
      const canRunTools = wantsTools && callNumber < maxModelCalls && budgetLeft;

      const results: ToolResult[] = [];
      if (canRunTools) {
        for (const call of response.toolCalls) {
          yield { type: "tool_call", ...call };
          const { result, event } = runTool(toolset, call);
          results.push(result);
          yield event;
        }
      }
      yield { type: "usage", iteration: callNumber, ...response.usage };

      if (!wantsTools) {
        if (response.stopReason === "refusal" && !streamed) {
          yield { type: "text", delta: refusalText };
        }
        const stopReason: ChatStopReason =
          response.stopReason === "tool_use" ? "end_turn" : response.stopReason;
        yield { type: "done", stopReason, usage: total };
        return;
      }
      if (!canRunTools) {
        const stopReason = budgetLeft ? "max_iterations" : "max_tokens";
        yield { type: "done", stopReason, usage: total };
        return;
      }

      messages.push(
        {
          role: "assistant",
          text: response.text,
          toolCalls: response.toolCalls,
          providerContent: response.providerContent,
        },
        { role: "tool_results", results },
      );
    }
  } catch (error) {
    // A call cut off (the visitor left) or failed after the provider accepted
    // it is still billed, but its usage never arrives: charge it
    // conservatively as its whole output cap plus the input it reported (or,
    // if it reported none, the previous call's input, which it includes).
    const billed = inFlight && (signal?.aborted || inFlight.input !== undefined);
    if (inFlight && billed) {
      yield {
        type: "usage",
        iteration: inFlight.callNumber,
        ...(inFlight.input ?? { inputTokens: lastInputTokens }),
        outputTokens: inFlight.maxTokens,
        estimated: true,
      };
    }
    if (signal?.aborted) return;
    const code: ChatErrorCode =
      error instanceof ModelUnavailableError ? "unavailable" : "internal";
    if (code === "internal") {
      logEvent("ERROR", "chat_failed", "Chat failed", {
        error: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    yield { type: "error", code, message: errorMessages[code] };
  }
}

function runTool(
  toolset: Toolset,
  call: { id: string; name: string; input: unknown },
): { result: ToolResult; event: ChatEvent } {
  let output: unknown;
  let isError = false;
  try {
    output = toolset.call(call.name, call.input);
  } catch (error) {
    if (!(error instanceof ToolInputError)) throw error;
    isError = true;
    output = { error: error.message };
  }
  return {
    result: { callId: call.id, output: JSON.stringify(output), isError },
    event: { type: "tool_result", id: call.id, name: call.name, isError, output },
  };
}
