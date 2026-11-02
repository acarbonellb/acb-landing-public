// Browser client for the agent's `POST /chat` SSE endpoint (contract in the
// README, "Chat endpoint contract"). It turns the wire protocol into the few
// events the UI renders, and folds every failure (HTTP error, stream `error`
// event, network failure, truncated stream) into one typed `error` event.

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ChatErrorKind = "rate_limited" | "unavailable" | "error";

export type ChatClientEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "done"; stopReason: string }
  | {
      type: "error";
      kind: ChatErrorKind;
      message?: string;
      retryAfterSeconds?: number;
    };

type ErrorPayload = {
  code?: unknown;
  message?: unknown;
  retryAfter?: unknown;
  retryAfterSeconds?: unknown;
};

function kindOf(code: unknown, status?: number): ChatErrorKind {
  if (code === "rate_limited" || status === 429) return "rate_limited";
  if (code === "unavailable" || status === 503) return "unavailable";
  return "error";
}

function seconds(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.ceil(n)
    : undefined;
}

function toError(
  payload: ErrorPayload | undefined,
  status?: number,
  retryAfterHeader?: string | null,
): ChatClientEvent {
  const event: ChatClientEvent = {
    type: "error",
    kind: kindOf(payload?.code, status),
  };
  if (typeof payload?.message === "string" && payload.message) {
    event.message = payload.message;
  }
  const retry =
    seconds(retryAfterHeader ?? undefined) ??
    seconds(payload?.retryAfterSeconds) ??
    seconds(payload?.retryAfter);
  if (retry !== undefined) event.retryAfterSeconds = retry;
  return event;
}

async function errorFromResponse(res: Response): Promise<ChatClientEvent> {
  let payload: ErrorPayload | undefined;
  try {
    const body = (await res.json()) as { error?: ErrorPayload };
    payload = body?.error;
  } catch {
    // Not JSON (e.g. a proxy's HTML error page): fall back on the status.
  }
  return toError(payload, res.status, res.headers.get("Retry-After"));
}

// Parses one SSE frame's `data:` lines into the JSON event it carries.
function parseFrame(frame: string): Record<string, unknown> | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return undefined;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toClientEvent(e: Record<string, unknown>): ChatClientEvent | undefined {
  switch (e.type) {
    case "text":
      return typeof e.delta === "string"
        ? { type: "text", delta: e.delta }
        : undefined;
    case "tool_call":
      return {
        type: "tool_call",
        id: String(e.id),
        name: String(e.name),
        input: e.input,
      };
    case "done":
      return { type: "done", stopReason: String(e.stopReason) };
    case "error":
      return toError(e as ErrorPayload);
    default:
      // tool_result, usage and future events are not rendered.
      return undefined;
  }
}

export async function* streamChat(
  url: string,
  messages: ChatMessage[],
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): AsyncGenerator<ChatClientEvent> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) return;
    yield {
      type: "error",
      kind: "error",
      message: "Couldn't reach the agent. Check your connection and try again.",
    };
    return;
  }

  if (!res.ok || !res.body) {
    yield await errorFromResponse(res);
    return;
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value.replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const raw = parseFrame(frame);
        const event = raw && toClientEvent(raw);
        if (!event) continue;
        yield event;
        if (event.type === "done" || event.type === "error") return;
      }
    }
  } catch {
    if (options.signal?.aborted) return;
  } finally {
    reader.cancel().catch(() => {});
  }
  yield {
    type: "error",
    kind: "error",
    message: "The answer was cut off. Please try again.",
  };
}
