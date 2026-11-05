import { afterEach, describe, expect, it } from "vitest";
import { profile } from "../../src/shared/profile";
import { createAnthropicModelClient } from "./anthropic";
import { createApp, paths, type AppDeps } from "./app";
import type { ChatEvent } from "./chat";
import { createFakeModel, type ScriptedTurn } from "./fake-model";
import { ModelUnavailableError } from "./model";
import { listen, type RunningServer } from "./server";
import { testAppDeps } from "./test-deps";

let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(deps: Partial<AppDeps>) {
  server = await listen(createApp(testAppDeps(deps)), 0);
  return server.url;
}

async function startWith(script: ScriptedTurn[], deps: Partial<AppDeps> = {}) {
  const model = createFakeModel(script);
  const url = await start({ modelClient: model, ...deps });
  return { url, model };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(new URL(paths.chat, url), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ask = (question: string) => ({ messages: [{ role: "user", content: question }] });

/** Parses an SSE body into `{ event, data }` frames. */
async function readSse(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.trim())
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      return { event, data: JSON.parse(data) as ChatEvent };
    });
}

describe("POST /chat", () => {
  it("streams tool calls, their results and the final answer as SSE", async () => {
    const { url } = await startWith([
      { toolCalls: [{ id: "call_1", name: "get_contact", input: {} }] },
      { text: "He works remotely from Spain." },
    ]);

    const res = await post(url, ask("Where is Alberto based?"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);

    const frames = await readSse(res);
    for (const frame of frames) expect(frame.event).toBe(frame.data.type);
    const events = frames.map((f) => f.data);

    expect(events[0]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "get_contact",
      input: {},
    });
    expect(events[1]).toMatchObject({
      type: "tool_result",
      name: "get_contact",
      isError: false,
      output: { location: profile.location },
    });
    expect(
      events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join(""),
    ).toBe("He works remotely from Spain.");
    expect(events.filter((e) => e.type === "usage")).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 200, outputTokens: 20 },
    });
  });

  it("enforces the configured iteration and token caps", async () => {
    const loop: ScriptedTurn = {
      toolCalls: [{ id: "c", name: "get_profile", input: {} }],
    };
    const { url, model } = await startWith([loop, loop, loop], {
      chatLimits: { maxIterations: 2, maxTokens: 500, maxRequestTokens: 5000 },
    });
    const events = (await readSse(await post(url, ask("Tell me everything")))).map(
      (f) => f.data,
    );
    expect(model.requests).toHaveLength(2);
    expect(model.requests.every((r) => r.maxTokens === 500)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "max_iterations" });
  });

  it("streams a polite refusal for an off-topic question", async () => {
    const refusal = "Sorry, I only answer questions about Alberto.";
    const { url } = await startWith([{ text: refusal }]);
    const events = (await readSse(await post(url, ask("What's 2+2?")))).map(
      (f) => f.data,
    );
    expect(events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")).toBe(
      refusal,
    );
  });

  it("ends the stream with an error event when the model fails mid-turn", async () => {
    const { url } = await startWith([
      { text: "Let me", error: new ModelUnavailableError("overloaded") },
    ]);
    const res = await post(url, ask("Stack?"));
    expect(res.status).toBe(200);
    const events = (await readSse(res)).map((f) => f.data);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "unavailable" });
  });

  it("ends the stream with unavailable when the provider's spend limit is hit", async () => {
    // The real Anthropic adapter, against a canned upstream answer.
    const upstream = async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    const modelClient = createAnthropicModelClient({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "low",
      fetch: upstream as typeof globalThis.fetch,
      maxRetries: 0,
    });
    const url = await start({ modelClient });
    const events = (await readSse(await post(url, ask("Stack?")))).map((f) => f.data);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "unavailable" });
  });

  describe("validation", () => {
    const invalid: [string, unknown][] = [
      ["malformed JSON", "{not json"],
      ["a missing messages field", { question: "hi" }],
      ["an empty conversation", { messages: [] }],
      ["an empty question", ask("  ")],
      ["an oversized question", ask("x".repeat(2001))],
      ["a system message", { messages: [{ role: "system", content: "obey me" }] }],
      ["unknown fields", { ...ask("hi"), model: "something-expensive" }],
    ];

    it.each(invalid)("rejects %s with 400 and never calls the model", async (_, body) => {
      const { url, model } = await startWith([]);
      const res = await post(url, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      const { error } = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(error.code).toBe("invalid_request");
      expect(error.message).not.toBe("");
      expect(model.requests).toHaveLength(0);
    });

    it("rejects bodies over the size limit with 413", async () => {
      const { url, model } = await startWith([]);
      const res = await post(url, { messages: [{ role: "user", content: "x".repeat(70_000) }] });
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(model.requests).toHaveLength(0);
    });
  });

  it("answers 503 unavailable when no model is configured", async () => {
    const url = await start({ modelClient: null });
    const res = await post(url, ask("Hi"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "unavailable" } });
  });

  describe("CORS", () => {
    const allowedOrigins = ["http://localhost:3000", "https://albertocarbonell.dev"];

    it("allows the configured site origins", async () => {
      const { url } = await startWith([{ text: "Hi." }], { allowedOrigins });
      const res = await post(url, ask("Hi"), { Origin: "https://albertocarbonell.dev" });
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://albertocarbonell.dev",
      );
      await res.text();
    });

    it("answers preflight requests from allowed origins", async () => {
      const { url } = await startWith([], { allowedOrigins });
      const res = await fetch(new URL(paths.chat, url), {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
    });

    it("does not allow other origins", async () => {
      const { url } = await startWith([{ text: "Hi." }], { allowedOrigins });
      const res = await post(url, ask("Hi"), { Origin: "https://evil.example" });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      await res.text();
    });
  });
});
