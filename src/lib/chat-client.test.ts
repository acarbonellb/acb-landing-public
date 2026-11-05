import { describe, expect, it } from "vitest";
import { chatError, done, sse, toResponse } from "@/testing/agent-fakes";
import { type ChatClientEvent, streamChat } from "./chat-client";

// A Response whose body arrives in the given chunks (to exercise frames split
// across reads).
function streamed(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function fakeFetch(response: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

async function collect(
  it: AsyncIterable<ChatClientEvent>,
): Promise<ChatClientEvent[]> {
  const out: ChatClientEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const question = [{ role: "user" as const, content: "Who is Alberto?" }];

describe("streamChat", () => {
  it("POSTs the conversation as JSON to the chat URL", async () => {
    const { fetch, calls } = fakeFetch(
      streamed([sse(done())]),
    );

    await collect(streamChat("http://agent.test/chat", question, { fetch }));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://agent.test/chat");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      messages: question,
    });
  });

  it("yields text, tool calls and done, even when frames split across reads", async () => {
    const body = sse(
      { type: "tool_call", id: "t1", name: "get_projects", input: {} },
      {
        type: "tool_result",
        id: "t1",
        name: "get_projects",
        isError: false,
        output: [],
      },
      { type: "text", delta: "He built " },
      { type: "usage", iteration: 1, inputTokens: 1, outputTokens: 1 },
      { type: "text", delta: "agents." },
      done("end_turn", "sig-1"),
    );
    const chunks = [body.slice(0, 7), body.slice(7, 90), body.slice(90)];
    const { fetch } = fakeFetch(streamed(chunks));

    const events = await collect(streamChat("/chat", question, { fetch }));

    expect(events).toEqual([
      { type: "tool_call", id: "t1", name: "get_projects", input: {} },
      { type: "text", delta: "He built " },
      { type: "text", delta: "agents." },
      { type: "done", stopReason: "end_turn", signature: "sig-1" },
    ]);
  });

  it("turns a stream error event into a typed error", async () => {
    const { fetch } = fakeFetch(
      streamed([
        sse(
          { type: "text", delta: "Hi" },
          { type: "error", code: "unavailable", message: "Busy, retry." },
        ),
      ]),
    );

    const events = await collect(streamChat("/chat", question, { fetch }));

    expect(events.at(-1)).toEqual({
      type: "error",
      kind: "unavailable",
      message: "Busy, retry.",
    });
  });

  it("maps HTTP 429 to rate_limited with Retry-After seconds", async () => {
    const { fetch } = fakeFetch(
      toResponse(
        chatError(
          { code: "rate_limited", message: "Slow down." },
          { headers: { "Retry-After": "42" } },
        ),
      ),
    );

    const events = await collect(streamChat("/chat", question, { fetch }));

    expect(events).toEqual([
      {
        type: "error",
        kind: "rate_limited",
        message: "Slow down.",
        retryAfterSeconds: 42,
      },
    ]);
  });

  it("reads retry info from the error body when there is no header", async () => {
    const { fetch } = fakeFetch(
      toResponse(chatError({ code: "rate_limited", message: "x", retryAfterSeconds: 7 })),
    );

    const [event] = await collect(streamChat("/chat", question, { fetch }));

    expect(event).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 7 });
  });

  it("maps a 503 unavailable response to unavailable", async () => {
    const { fetch } = fakeFetch(
      toResponse(chatError({ code: "unavailable", message: "Chat is off this month." })),
    );

    const events = await collect(streamChat("/chat", question, { fetch }));

    expect(events).toEqual([
      {
        type: "error",
        kind: "unavailable",
        message: "Chat is off this month.",
      },
    ]);
  });

  it("passes on when the spend cap renews", async () => {
    const { fetch } = fakeFetch(
      toResponse(
        chatError({
          code: "unavailable",
          message: "Budget used up.",
          resetsAt: "2026-12-01T00:00:00.000Z",
        }),
      ),
    );

    const [event] = await collect(streamChat("/chat", question, { fetch }));

    expect(event).toMatchObject({
      kind: "unavailable",
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
  });

  it("drops a renewal time that isn't a date", async () => {
    const { fetch } = fakeFetch(
      toResponse(chatError({ code: "unavailable", message: "x", resetsAt: "soon" })),
    );

    const [event] = await collect(streamChat("/chat", question, { fetch }));

    expect(event).not.toHaveProperty("resetsAt");
  });

  it("falls back to a generic error for unknown codes and non-JSON bodies", async () => {
    const unknown = fakeFetch(
      Response.json(
        { error: { code: "teapot", message: "I'm a teapot." } },
        { status: 418 },
      ),
    );
    const html = fakeFetch(new Response("<h1>Bad gateway</h1>", { status: 502 }));

    expect(
      await collect(streamChat("/chat", question, { fetch: unknown.fetch })),
    ).toEqual([{ type: "error", kind: "error", message: "I'm a teapot." }]);
    expect(
      await collect(streamChat("/chat", question, { fetch: html.fetch })),
    ).toEqual([
      expect.objectContaining({ type: "error", kind: "error" }),
    ]);
  });

  it("reports a network failure as a generic error", async () => {
    const { fetch } = fakeFetch(new TypeError("Failed to fetch"));

    const events = await collect(streamChat("/chat", question, { fetch }));

    expect(events).toEqual([
      expect.objectContaining({ type: "error", kind: "error" }),
    ]);
  });

  it("reports a stream that ends without done or error", async () => {
    const { fetch } = fakeFetch(streamed([sse({ type: "text", delta: "Hi" })]));

    const events = await collect(streamChat("/chat", question, { fetch }));

    expect(events.at(-1)).toMatchObject({ type: "error", kind: "error" });
  });
});
