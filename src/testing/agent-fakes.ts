// Fakes of the agent service's answers, for the site's unit tests (Vitest)
// and browser tests (Playwright, through e2e/fixtures.ts). Each is typed
// against the shared contracts, so changing a chat event, an error body or
// the stats shape breaks the fakes at type-check instead of letting tests
// stub a shape the agent no longer sends. Plain TypeScript with relative
// imports: Playwright doesn't resolve the `@/` alias.
import type { ChatEvent, HttpErrorBody, HttpErrorCode } from "../shared/chat-contract";
import type { GetContactResponse } from "../shared/mcp-contact";
import type { StatsResponse, WeekStats } from "../shared/stats-contract";

/** An HTTP answer, as both `new Response()` and Playwright's `route.fulfill` take it. */
export type FakeReply = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** The SSE body of a chat stream: one `event:`/`data:` frame per event. */
export function sse(...events: ChatEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** The `done` event that closes an answer (usage is ignored by the site). */
export function done(stopReason: Extract<ChatEvent, { type: "done" }>["stopReason"] = "end_turn"): ChatEvent {
  return { type: "done", stopReason, usage: { inputTokens: 0, outputTokens: 0 } };
}

/** A chat stream that sends `events`, then ends. */
export function chatStream(...events: ChatEvent[]): FakeReply {
  return { status: 200, headers: { "Content-Type": "text/event-stream" }, body: sse(...events) };
}

/** A chat answer that names the contact address after a `get_contact` call. */
export function contactAnswer(email: string): FakeReply {
  return chatStream(
    { type: "tool_call", id: "t1", name: "get_contact", input: {} },
    { type: "text", delta: `You can email Alberto at ${email}.` },
    done(),
  );
}

const statusOf: Record<HttpErrorCode, number> = {
  invalid_request: 400,
  rate_limited: 429,
  unavailable: 503,
};

/**
 * A chat refusal before streaming. The status follows the code unless
 * given; headers (such as `Retry-After`) are only the ones passed.
 */
export function chatError(
  error: HttpErrorBody["error"],
  init: { status?: number; headers?: Record<string, string> } = {},
): FakeReply {
  return json(init.status ?? statusOf[error.code], { error } satisfies HttpErrorBody, init.headers);
}

/** The MCP server's answer to the contact fallback's `get_contact` call. */
export function mcpContact(email: string): FakeReply {
  const body: GetContactResponse = { jsonrpc: "2.0", id: 1, result: { structuredContent: { email } } };
  return json(200, body);
}

/** A week of usage with no traffic, with `chat` fields overridden. */
export function weekStats(week: string, chat: Partial<WeekStats["chat"]> = {}): WeekStats {
  return {
    week,
    startsAt: "2026-11-02T00:00:00.000Z",
    chat: {
      requests: 0,
      answered: 0,
      outcomes: {},
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      errorRate: null,
      latency: { p50Ms: null, p95Ms: null },
      firstText: { p50Ms: null, p95Ms: null },
      ...chat,
    },
    mcp: { requests: 0, unknownGoogleHops: 0 },
  };
}

/** A `GET /stats` answer. */
export function stats(body: StatsResponse): FakeReply {
  return json(200, body);
}

/** A JSON answer; for bodies off the contracts on purpose (malformed, unknown codes). */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): FakeReply {
  return { status, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

/** The reply as a fetch `Response`, for unit tests. */
export function toResponse(reply: FakeReply): Response {
  return new Response(reply.body, { status: reply.status, headers: reply.headers });
}

/**
 * A chat stream the test pushes events into, to look at the UI mid-answer.
 */
export function controlledChatStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    push: (...events: ChatEvent[]) => controller.enqueue(encoder.encode(sse(...events))),
    close: () => controller.close(),
  };
}

type FetchReply = FakeReply | Response | Error | Promise<Response>;

/**
 * A fetch that serves the queued replies in order (an `Error` is thrown, as
 * a network failure) and records each request's URL and JSON body (`undefined` for a GET).
 */
export function fakeFetch(...replies: FetchReply[]) {
  const requests: { url: string; body: unknown }[] = [];
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ url: String(url), body });
    const next = replies.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    if (next instanceof Response || next instanceof Promise) return next;
    return toResponse(next);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}
