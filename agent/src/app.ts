import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import * as z from "zod";
import type { ChatRequest, HttpErrorBody, HttpErrorCode } from "../../src/shared/chat-contract";
import { chatRequestSchema, createChatAgent, errorMessages, type ChatLimits } from "./chat";
import { describeError, logEvent, withRequestId } from "./log";
import { createMcpServer } from "./mcp";
import { meteredChat } from "./metered-chat";
import type { ModelClient } from "./model";
import { watchingProviderLimit, type ProviderLimitWatch } from "./provider-limit";
import type { RateLimitDecision, RateLimiter } from "./rate-limit";
import type { SpendCap } from "./spend-cap";
import type { Toolset } from "./tools";
import type { UsageRecorder } from "./usage";

export type { HttpErrorBody, HttpErrorCode };

/** HTTP paths served by the agent service. */
export const paths = {
  health: "/health",
  mcp: "/mcp",
  chat: "/chat",
  stats: "/stats",
} as const;

/** Largest chat request body accepted, in bytes. */
export const maxChatBodyBytes = 64 * 1024;

/** User-facing messages of the HTTP-layer refusals, safe to show as-is. */
export const httpErrorMessages = {
  rateLimited: "Too many requests. Please wait a moment and try again.",
  statsUnavailable: "Usage stats are unavailable.",
  spendCap:
    "The agent has used up its budget for this month, so it's resting until next month. You can still read everything on this page or contact Alberto directly.",
} as const;

/**
 * Everything the service depends on, all required: production builds them
 * from the configuration (`compose.ts`), tests from the memory adapters and
 * the fake model (`test-deps.ts`).
 */
export type AppDeps = {
  toolset: Toolset;
  /** `null` when no model is configured: the chat answers 503. */
  modelClient: ModelClient | null;
  /** Browser origins allowed to call the chat endpoint. */
  allowedOrigins: string[];
  chatLimits: ChatLimits;
  /**
   * Per-IP limits: in the shared store when `AGENT_STORE` selects one, else
   * in memory, per instance (`rate-limit.ts`).
   */
  chatRateLimiter: RateLimiter;
  mcpRateLimiter: RateLimiter;
  /** Monthly model budget; shared or in memory like the limits (`spend-cap.ts`). */
  spendCap: SpendCap;
  /** Weekly usage aggregates served by `/stats`; in the same store (`usage.ts`). */
  usage: UsageRecorder;
  /** Notes the provider's own spend limit, for its alert event; in the same store (`provider-limit.ts`). */
  providerLimit: ProviderLimitWatch;
  /** Key for the `/chat` and `/stats` rate limits: the client IP, or its `/64` for IPv6, in production. */
  rateLimitKey: (c: Context) => string;
  /** Key for the `/mcp` rate limit: the client IP (or its `/64`), through the Hosting rewrite too. */
  mcpRateLimitKey: (c: Context) => string;
};

const jsonError = (
  c: Context,
  status: 400 | 413 | 429 | 503,
  error: HttpErrorBody["error"],
) => c.json<HttpErrorBody>({ error }, status);

/**
 * What a route does when its store fails: `open` keeps answering without the
 * guardrail, `closed` refuses (the error reaches `app.onError`, which answers
 * in the route's error contract).
 */
type StoreFailurePolicy = "open" | "closed";

/**
 * Per-client rate limit: lets the request through, or sets `Retry-After` and
 * answers with `refuse` (each endpoint words the refusal in its protocol). If
 * the limiter's store fails, `onStoreFailure` decides.
 */
function rateLimit(
  limiter: RateLimiter,
  rateLimitKey: (c: Context) => string,
  onStoreFailure: StoreFailurePolicy,
  refuse: (c: Context, retryAfterSeconds: number) => Response | Promise<Response>,
): MiddlewareHandler {
  return async (c, next) => {
    let decision: RateLimitDecision;
    try {
      decision = await limiter.hit(rateLimitKey(c));
    } catch (error) {
      if (onStoreFailure === "closed") throw error;
      logEvent("ERROR", "store_error", `Rate limit: store failed, letting ${c.req.path} through`, {
        operation: "rate_limit",
        route: c.req.path,
        error: describeError(error),
      });
      return next();
    }
    if (decision.allowed) return next();
    c.header("Retry-After", String(decision.retryAfterSeconds));
    return refuse(c, decision.retryAfterSeconds);
  };
}

/** Notes when a chat request arrived, in its context, for its latency (`usage.ts`). */
const markChatStart = createMiddleware<{ Variables: { chatStartedAt: number } }>(async (c, next) => {
  c.set("chatStartedAt", performance.now());
  await next();
});

/**
 * Logs a chat request refused as invalid (`400`, `413`), which isn't recorded
 * in the usage stats: every other one is logged as it's recorded (`usage.ts`).
 */
function logInvalidChat(status: number) {
  logEvent("INFO", "chat_request", `Chat request: http_${status}`, {
    outcome: `http_${status}`,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    totalMs: null,
    firstTextMs: null,
    modelCalls: 0,
  });
}

/** The chat request in the body, or the `400` that refuses it. */
async function parseChatRequest(c: Context): Promise<ChatRequest | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, { code: "invalid_request", message: "Request body must be JSON." });
  }
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(c, 400, { code: "invalid_request", message: z.prettifyError(parsed.error) });
  }
  return parsed.data;
}

export function createApp(deps: AppDeps): Hono {
  const {
    toolset,
    modelClient,
    allowedOrigins,
    chatLimits,
    chatRateLimiter,
    mcpRateLimiter,
    spendCap,
    usage,
    providerLimit,
    rateLimitKey,
    mcpRateLimitKey,
  } = deps;
  // One agent for every chat request: its estimate and its run share the
  // toolset, limits and system prompt.
  const chatAgent = modelClient
    ? createChatAgent({
        model: watchingProviderLimit(modelClient, providerLimit),
        toolset,
        limits: chatLimits,
      })
    : null;
  const app = new Hono();

  // Every request gets an id, echoed in `X-Request-Id`, that tags each line
  // logged while serving it (`log.ts`), its stream and store writes included.
  app.use(async (c, next) => {
    const requestId = randomUUID();
    c.header("X-Request-Id", requestId);
    await withRequestId(requestId, next);
  });

  app.get(paths.health, (c) => c.json({ status: "ok" }));

  // Public usage aggregates (no content, no IPs), read by the site from any
  // origin. Under the MCP rate limit, sharing its per-IP count.
  app.use(paths.stats, cors({ origin: "*", allowMethods: ["GET"] }));
  app.get(
    paths.stats,
    rateLimit(mcpRateLimiter, rateLimitKey, "open", (c) =>
      jsonError(c, 429, { code: "rate_limited", message: httpErrorMessages.rateLimited }),
    ),
    async (c) => {
      try {
        const body = await usage.stats();
        c.header("Cache-Control", "public, max-age=300");
        return c.json(body);
      } catch (error) {
        logEvent("ERROR", "store_error", "Usage: could not read the stats", {
          operation: "usage_stats",
          error: describeError(error),
        });
        return jsonError(c, 503, {
          code: "unavailable",
          message: httpErrorMessages.statsUnavailable,
        });
      }
    },
  );

  // Public, read-only MCP server: any origin may call it, nothing uses cookies.
  app.use(
    paths.mcp,
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "mcp-session-id",
        "mcp-protocol-version",
        "Last-Event-ID",
      ],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version", "Retry-After"],
    }),
  );

  // Per-IP limit. Answered as a JSON-RPC error so MCP clients can surface it.
  app.use(
    paths.mcp,
    rateLimit(mcpRateLimiter, mcpRateLimitKey, "open", (c, retryAfterSeconds) =>
      c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message: httpErrorMessages.rateLimited,
            data: { code: "rate_limited" satisfies HttpErrorCode, retryAfterSeconds },
          },
        },
        429,
      ),
    ),
  );

  // Stateless Streamable HTTP: a fresh server and transport per request, so
  // any Cloud Run instance can answer any request and nothing is kept in
  // memory between them.
  app.all(paths.mcp, async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(toolset);
    await server.connect(transport);
    const [response] = await Promise.all([transport.handleRequest(c.req.raw), usage.recordMcp()]);
    return response;
  });

  // The chat spends model tokens, so only the site's own origins may call it
  // from a browser.
  app.use(
    paths.chat,
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
      // The chat UI reads it on a 429.
      exposeHeaders: ["Retry-After"],
      maxAge: 600,
    }),
  );

  app.post(
    paths.chat,
    markChatStart,
    // Counted before anything else, so malformed requests count too.
    rateLimit(chatRateLimiter, rateLimitKey, "closed", async (c, retryAfterSeconds) => {
      await usage.recordChat({ outcome: "http_429" });
      return jsonError(c, 429, {
        code: "rate_limited",
        message: httpErrorMessages.rateLimited,
        retryAfterSeconds,
      });
    }),
    bodyLimit({
      maxSize: maxChatBodyBytes,
      onError: (c) => {
        logInvalidChat(413);
        return jsonError(c, 413, { code: "invalid_request", message: "Request body is too large." });
      },
    }),
    async (c) => {
      const request = await parseChatRequest(c);
      if (request instanceof Response) {
        logInvalidChat(request.status);
        return request;
      }
      if (!chatAgent) {
        await usage.recordChat({ outcome: "http_503" });
        return jsonError(c, 503, { code: "unavailable", message: errorMessages.unavailable });
      }
      const { messages } = request;
      // Reserve the most this request can cost while it runs (see spend-cap.ts).
      const spend = await spendCap.reserve(chatAgent.worstCaseUsage(messages));
      if (spend.exhausted) {
        await usage.recordChat({ outcome: "http_503" });
        return jsonError(c, 503, {
          code: "unavailable",
          message: httpErrorMessages.spendCap,
          resetsAt: spend.resetsAt,
        });
      }

      // A closed connection aborts the model call, so nobody pays for an
      // answer no one reads.
      const abort = new AbortController();
      const stop = () => abort.abort();
      c.req.raw.signal.addEventListener("abort", stop, { once: true });
      const events = meteredChat(messages, {
        agent: chatAgent,
        reservation: spend.reservation,
        usage,
        startedAt: c.get("chatStartedAt"),
        signal: abort.signal,
      });
      return streamSSE(c, async (stream) => {
        stream.onAbort(stop);
        // Drained to the end even once the visitor has left: every model call
        // is paid for, and the metered chat records it when the run ends.
        for await (const event of events) {
          if (stream.aborted) continue;
          try {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          } catch {
            stop();
          }
        }
      });
    },
  );

  // Whatever a route didn't handle (a store failing where the route fails
  // closed, or a bug) is answered in that route's error contract, never as
  // Hono's plain-text 500. The CORS headers set before the error stay on.
  app.onError((error, c) => {
    logEvent("ERROR", "unhandled_error", `Unhandled error on ${c.req.method} ${c.req.path}`, {
      method: c.req.method,
      route: c.req.path,
      error: describeError(error),
      stack: error.stack,
    });
    if (c.req.path === paths.mcp) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: errorMessages.unavailable,
            data: { code: "unavailable" satisfies HttpErrorCode },
          },
        },
        503,
      );
    }
    const message =
      c.req.path === paths.stats ? httpErrorMessages.statsUnavailable : errorMessages.unavailable;
    return jsonError(c, 503, { code: "unavailable", message });
  });

  return app;
}
