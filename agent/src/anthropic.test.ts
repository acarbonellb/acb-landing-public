// The Anthropic adapter, driven by the real SDK against a canned `fetch`:
// no request ever leaves the process.
import { describe, expect, it } from "vitest";
import { anthropicRequestParams, createAnthropicModelClient } from "./anthropic";
import { ModelUnavailableError, type ModelRequest, type ModelStreamEvent } from "./model";

type Captured = { url: string; body: Record<string, unknown>; headers: Headers };

function sse(events: Record<string, unknown>[]) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const toolTurn = sse([
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name: "get_projects", input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"status":"in-progress"}' },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 30 },
  },
  { type: "message_stop" },
]);

function fakeFetch(response: () => Response) {
  const calls: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    return response();
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const request: ModelRequest = {
  system: "Be helpful.",
  maxTokens: 777,
  tools: [
    {
      name: "get_projects",
      description: "Projects",
      inputSchema: { type: "object", properties: { status: { type: "string" } } },
    },
  ],
  messages: [
    { role: "user", text: "Hi" },
    { role: "assistant", text: "Hello!" },
    { role: "user", text: "Projects?" },
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "toolu_0", name: "get_projects", input: {} }],
    },
    { role: "tool_results", results: [{ callId: "toolu_0", output: "{}", isError: false }] },
  ],
};

async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe("Anthropic model client", () => {
  it("maps the request to a streaming Messages API call", async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(toolTurn, { headers: { "content-type": "text/event-stream" } }),
    );
    const client = createAnthropicModelClient({
      apiKey: "test-key",
      model: "claude-opus-5-5",
      effort: "low",
      fetch,
    });
    await collect(client.stream(request));

    const [{ body, headers }] = calls;
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(body).toMatchObject({
      fallbacks: "default",
      model: "claude-opus-5-5",
      max_tokens: 777,
      stream: true,
      system: "Be helpful.",
      output_config: { effort: "low" },
      tools: [
        {
          name: "get_projects",
          description: "Projects",
          input_schema: { type: "object", properties: { status: { type: "string" } } },
        },
      ],
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
        { role: "user", content: "Projects?" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_0", name: "get_projects", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_0", content: "{}", is_error: false },
          ],
        },
      ],
    });
  });

  it("sends exactly the request parameters it reports, which eval recordings store", async () => {
    for (const model of ["claude-haiku-5-5", "claude-opus-5-5"]) {
      const { fetch, calls } = fakeFetch(
        () => new Response(toolTurn, { headers: { "content-type": "text/event-stream" } }),
      );
      const options = { model, effort: "medium" as const };
      await collect(createAnthropicModelClient({ apiKey: "k", fetch, ...options }).stream(request));

      const [{ body, headers }] = calls;
      // The rest are the request's own: what a recording's request hash covers.
      const own = new Set(["model", "max_tokens", "stream", "system", "tools", "messages"]);
      const sent = Object.fromEntries(Object.entries(body).filter(([key]) => !own.has(key)));
      const betas = headers.get("anthropic-beta");
      expect({ ...sent, ...(betas && { betas: betas.split(",") }) }).toEqual(
        anthropicRequestParams(options),
      );
    }
    expect(anthropicRequestParams({ model: "claude-haiku-5-5", effort: "low" })).toEqual({
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
    });
  });

  it("streams text deltas and ends with the response", async () => {
    const { fetch } = fakeFetch(
      () => new Response(toolTurn, { headers: { "content-type": "text/event-stream" } }),
    );
    const client = createAnthropicModelClient({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "low",
      fetch,
    });
    const events = await collect(client.stream(request));
    expect(events.slice(0, 3)).toEqual([
      // Reported as soon as the call starts, so an aborted call can be priced.
      { type: "input_usage", inputTokens: 120 },
      { type: "text_delta", text: "Let me " },
      { type: "text_delta", text: "check." },
    ]);
    const end = events.at(-1);
    if (end?.type !== "response_end") throw new Error("expected response_end");
    expect(end.response).toMatchObject({
      text: "Let me check.",
      toolCalls: [{ id: "toolu_1", name: "get_projects", input: { status: "in-progress" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    // Raw content is kept so the next call replays it verbatim.
    expect(end.response.providerContent).toHaveLength(2);
  });

  it("reports cache writes and reads within the input, so they can be priced apart", async () => {
    const cached = toolTurn.replace(
      JSON.stringify({ input_tokens: 120, output_tokens: 1 }),
      JSON.stringify({
        input_tokens: 20,
        cache_creation_input_tokens: 70,
        cache_read_input_tokens: 30,
        output_tokens: 1,
      }),
    );
    const { fetch } = fakeFetch(
      () => new Response(cached, { headers: { "content-type": "text/event-stream" } }),
    );
    const client = createAnthropicModelClient({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "low",
      fetch,
    });
    const events = await collect(client.stream(request));
    const cacheUsage = { inputTokens: 120, cacheWriteInputTokens: 70, cacheReadInputTokens: 30 };
    expect(events[0]).toEqual({ type: "input_usage", ...cacheUsage });
    const end = events.at(-1);
    if (end?.type !== "response_end") throw new Error("expected response_end");
    expect(end.response.usage).toEqual({ ...cacheUsage, outputTokens: 30 });
  });

  it("replays provider content verbatim on the next call", async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(toolTurn, { headers: { "content-type": "text/event-stream" } }),
    );
    const client = createAnthropicModelClient({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "low",
      fetch,
    });
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }];
    await collect(
      client.stream({
        ...request,
        messages: [
          { role: "user", text: "Q" },
          { role: "assistant", text: "", toolCalls: [], providerContent: raw },
          { role: "tool_results", results: [] },
        ],
      }),
    );
    expect((calls[0].body.messages as unknown[])[1]).toEqual({
      role: "assistant",
      content: raw,
    });
  });

  it.each([429, 500, 529])(
    "turns an upstream %i into ModelUnavailableError, for capacity",
    async (status) => {
      const { fetch } = fakeFetch(
        () =>
          new Response(JSON.stringify({ type: "error", error: { type: "x", message: "no" } }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      );
      const client = createAnthropicModelClient({
        apiKey: "k",
        model: "claude-opus-5-5",
        effort: "low",
        fetch,
        maxRetries: 0,
      });
      const error = await collect(client.stream(request)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelUnavailableError);
      expect(error).toMatchObject({ reason: "capacity" });
    },
  );

  // The provider's own limits (docs: "Rate limits" > "Spend limits"). A
  // workspace or organization spend limit set in the Console answers 400
  // with a message naming it; no credit is a 402 billing_error.
  const providerLimits: [string, number, { type: string; message: string }][] = [
    [
      "a workspace spend limit",
      400,
      {
        type: "invalid_request_error",
        message:
          "You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
      },
    ],
    [
      "an organization spend limit",
      400,
      {
        type: "invalid_request_error",
        message:
          "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
      },
    ],
    [
      "a billing problem (no credit left)",
      402,
      { type: "billing_error", message: "Your credit balance is too low to access the API." },
    ],
  ];

  it.each(providerLimits)("turns %s into ModelUnavailableError, for the provider limit", async (_, status, error) => {
    const { fetch } = fakeFetch(
      () =>
        new Response(JSON.stringify({ type: "error", error }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createAnthropicModelClient({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "low",
      fetch,
      maxRetries: 0,
    });
    const thrown = await collect(client.stream(request)).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ModelUnavailableError);
    expect(thrown).toMatchObject({ reason: "provider_limit" });
  });

  it("keeps any other 400 an internal error", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "messages: field required" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const client = createAnthropicModelClient({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "low",
      fetch,
      maxRetries: 0,
    });
    const error = await collect(client.stream(request)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ModelUnavailableError);
  });

  // After a 200 the provider reports trouble as an SSE `error` event; the SDK
  // raises a plain APIError with no status, so only the body's type tells.
  function midStreamError(type: string) {
    const [start] = toolTurn.split("\n\n");
    const error = { type: "error", error: { type, message: "Try again." } };
    return `${start}\n\nevent: error\ndata: ${JSON.stringify(error)}\n\n`;
  }

  it.each(["overloaded_error", "rate_limit_error"])(
    "turns a mid-stream %s into ModelUnavailableError",
    async (type) => {
      const { fetch } = fakeFetch(
        () =>
          new Response(midStreamError(type), {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const client = createAnthropicModelClient({
        apiKey: "k",
        model: "claude-opus-5-5",
        effort: "low",
        fetch,
        maxRetries: 0,
      });
      await expect(collect(client.stream(request))).rejects.toBeInstanceOf(
        ModelUnavailableError,
      );
    },
  );

  it("keeps any other mid-stream error an internal error", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(midStreamError("api_error"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const client = createAnthropicModelClient({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "low",
      fetch,
      maxRetries: 0,
    });
    const error = await collect(client.stream(request)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ModelUnavailableError);
  });

  it("lets other API errors (e.g. a bad key) through as internal errors", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "auth", message: "no" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createAnthropicModelClient({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "low",
      fetch,
      maxRetries: 0,
    });
    const error = await collect(client.stream(request)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ModelUnavailableError);
  });
});
