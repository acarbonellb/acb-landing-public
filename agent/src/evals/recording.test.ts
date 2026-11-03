import { describe, expect, it } from "vitest";
import { createFakeModel } from "../fake-model";
import type { ModelRequest, ModelStreamEvent } from "../model";
import {
  createRecordingModelClient,
  createReplayModelClient,
  requestHash,
  StaleRecordingError,
  type RecordedCall,
} from "./recording";

const request: ModelRequest = {
  system: "Be brief.",
  messages: [{ role: "user", text: "hola" }],
  tools: [{ name: "get_contact", description: "Contact", inputSchema: { type: "object" } }],
  maxTokens: 100,
};

async function drain(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("requestHash", () => {
  it("is a SHA-256 hex digest that ignores key order and the abort signal", () => {
    const reordered = {
      maxTokens: 100,
      tools: [{ inputSchema: { type: "object" }, description: "Contact", name: "get_contact" }],
      messages: [{ text: "hola", role: "user" as const }],
      system: "Be brief.",
      signal: new AbortController().signal,
    };

    expect(requestHash(request)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash(reordered)).toBe(requestHash(request));
  });

  it("changes when any part of the request changes", () => {
    const base = requestHash(request);

    expect(requestHash({ ...request, system: "Be brief!" })).not.toBe(base);
    expect(requestHash({ ...request, maxTokens: 101 })).not.toBe(base);
    expect(requestHash({ ...request, messages: [{ role: "user", text: "hola!" }] })).not.toBe(base);
    expect(
      requestHash({ ...request, tools: [{ ...request.tools[0], description: "Contacts" }] }),
    ).not.toBe(base);
  });
});

describe("createRecordingModelClient", () => {
  it("passes the inner client's events through and records them with the request hash", async () => {
    const inner = createFakeModel([
      { text: "Hola, soy", usage: { inputTokens: 12, outputTokens: 3 } },
    ]);
    let clock = 1000;
    const recorder = createRecordingModelClient(inner, { now: () => (clock += 250) });

    const events = await drain(recorder.stream(request));

    expect(events.map((e) => e.type)).toEqual([
      "input_usage",
      "text_delta",
      "text_delta",
      "turn_end",
    ]);
    expect(recorder.calls).toEqual([
      { requestHash: requestHash(request), latencyMs: 250, events },
    ]);
  });

  it("hashes the request as it was sent, even if the caller mutates it afterwards", async () => {
    const recorder = createRecordingModelClient(createFakeModel([{ text: "Hi" }]));
    const mutable: ModelRequest = { ...request, messages: [...request.messages] };
    const sent = requestHash(mutable);

    await drain(recorder.stream(mutable));
    mutable.messages.push({ role: "assistant", text: "Hi" });

    expect(recorder.calls[0].requestHash).toBe(sent);
  });

  it("records nothing for a call that fails", async () => {
    const recorder = createRecordingModelClient(
      createFakeModel([{ text: "Hal", error: new Error("model down") }]),
    );

    await expect(drain(recorder.stream(request))).rejects.toThrow("model down");
    expect(recorder.calls).toEqual([]);
  });
});

describe("createReplayModelClient", () => {
  const second: ModelRequest = {
    ...request,
    messages: [...request.messages, { role: "assistant", text: "Hola" }, { role: "user", text: "?" }],
  };

  async function recordTwo(): Promise<RecordedCall[]> {
    const recorder = createRecordingModelClient(
      createFakeModel([{ text: "Hola" }, { text: "Sí" }]),
    );
    await drain(recorder.stream(request));
    await drain(recorder.stream(second));
    return recorder.calls;
  }

  async function staleReason(run: () => Promise<unknown>) {
    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StaleRecordingError);
    expect((error as Error).message).toMatch(/re-run `pnpm agent:eval` and commit/);
    return (error as StaleRecordingError).reason;
  }

  it("yields the recorded events of each call in order", async () => {
    const calls = await recordTwo();
    const replay = createReplayModelClient(calls);

    expect(await drain(replay.stream(request))).toEqual(calls[0].events);
    expect(await drain(replay.stream(second))).toEqual(calls[1].events);
  });

  it("is stale when a request differs from the recorded one", async () => {
    const replay = createReplayModelClient(await recordTwo());

    expect(await staleReason(() => drain(replay.stream({ ...request, system: "Be kind." })))).toBe(
      "request_changed",
    );
  });

  it("is stale when the loop makes more calls than were recorded", async () => {
    const calls = await recordTwo();
    const replay = createReplayModelClient(calls.slice(0, 1));
    await drain(replay.stream(request));

    expect(await staleReason(() => drain(replay.stream(second)))).toBe("missing_step");
  });

  it("is stale when there is no recording at all", async () => {
    const replay = createReplayModelClient(undefined);

    expect(await staleReason(() => drain(replay.stream(request)))).toBe("missing_recording");
  });

  it("remembers the stale error it threw, for callers that swallow it", async () => {
    const replay = createReplayModelClient(undefined);
    await drain(replay.stream(request)).catch(() => {});

    expect(replay.staleError?.reason).toBe("missing_recording");
  });
});
