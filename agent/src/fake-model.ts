// A deterministic, scripted model client for tests. Never calls a real API.
import {
  inputOf,
  type ModelClient,
  type ModelRequest,
  type ModelStopReason,
  type ModelStreamEvent,
  type ToolCall,
  type Usage,
} from "./model";

export type ScriptedResponse = {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason?: ModelStopReason;
  usage?: Usage;
  /** Throw this instead of answering (after streaming `text`, if any). */
  error?: Error;
  /**
   * After streaming `text`, never finish: wait for the request's abort
   * signal and throw its reason, like a call the client disconnected from.
   */
  hang?: boolean;
};

export type FakeModel = ModelClient & {
  /** Every request the fake received, in order (messages are snapshots). */
  requests: ModelRequest[];
};

/** Rejects with the signal's reason once it aborts (never, without one). */
function abortOf(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * Plays `script` one response per model call. A function entry decides from the
 * request. Text is streamed word by word. Running past the script throws.
 */
export function createFakeModel(
  script: (ScriptedResponse | ((request: ModelRequest) => ScriptedResponse))[],
): FakeModel {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const entry = script[requests.length - 1];
      if (!entry) throw new Error(`Fake model has no response #${requests.length}`);
      const scripted = typeof entry === "function" ? entry(request) : entry;
      const text = scripted.text ?? "";
      const usage = scripted.usage ?? { inputTokens: 100, outputTokens: 10 };
      yield { type: "input_usage", ...inputOf(usage) };
      for (const word of text.match(/\S+\s*/g) ?? []) {
        yield { type: "text_delta", text: word };
      }
      if (scripted.error) throw scripted.error;
      if (scripted.hang) await abortOf(request.signal);
      const toolCalls = scripted.toolCalls ?? [];
      yield {
        type: "response_end",
        response: {
          text,
          toolCalls,
          stopReason: scripted.stopReason ?? (toolCalls.length ? "tool_use" : "end_turn"),
          usage,
        },
      };
    },
  };
}
