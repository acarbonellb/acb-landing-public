// A deterministic, scripted model client for tests. Never calls a real API.
import type {
  ModelClient,
  ModelRequest,
  ModelStopReason,
  ModelStreamEvent,
  ToolCall,
  Usage,
} from "./model";

export type ScriptedTurn = {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason?: ModelStopReason;
  usage?: Usage;
  /** Throw this instead of answering (after streaming `text`, if any). */
  error?: Error;
};

export type FakeModel = ModelClient & {
  /** Every request the fake received, in order (messages are snapshots). */
  requests: ModelRequest[];
};

/**
 * Plays `script` one turn per call. A function entry decides from the
 * request. Text is streamed word by word. Running past the script throws.
 */
export function createFakeModel(
  script: (ScriptedTurn | ((request: ModelRequest) => ScriptedTurn))[],
): FakeModel {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(request): AsyncIterable<ModelStreamEvent> {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const entry = script[requests.length - 1];
      if (!entry) throw new Error(`Fake model has no turn #${requests.length}`);
      const turn = typeof entry === "function" ? entry(request) : entry;
      const text = turn.text ?? "";
      for (const word of text.match(/\S+\s*/g) ?? []) {
        yield { type: "text_delta", text: word };
      }
      if (turn.error) throw turn.error;
      const toolCalls = turn.toolCalls ?? [];
      yield {
        type: "turn_end",
        turn: {
          text,
          toolCalls,
          stopReason: turn.stopReason ?? (toolCalls.length ? "tool_use" : "end_turn"),
          usage: turn.usage ?? { inputTokens: 100, outputTokens: 10 },
        },
      };
    },
  };
}
