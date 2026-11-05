import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import * as z from "zod";
import type { ChatMessage, HttpErrorBody, HttpErrorCode } from "../../src/shared/chat-contract";
import type { AnswerSigner } from "./answer-signing";
import { chatRequestSchema, createChatAgent, errorMessages, type ChatLimits } from "./chat";
import { describeError, logEvent, logStoreError, withRequestId } from "./log";
import type { DailyQuota } from "./daily-quota";
import { createMcpServer } from "./mcp";
import { meteredChat } from "./metered-chat";
import type { ModelClient } from "./model";
import { watchingProviderLimit, type ProviderLimitWatch } from "./provider-limit";
import type { RateLimitDecision, RateLimiter } from "./rate-limit";
import type { SpendCap } from "./spend-cap";
import { combineReservations } from "./spend-holds";
import type { Toolset } from "./tools";
import { logChatRequest, type UsageRecorder } from "./usage";

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
  dailyQuota:
    "You've asked the agent a lot today, so it's resting for you until tomorrow. You can still read everything on this page or contact Alberto directly.",
  statsUnavailable: "Usage stats are unavailable.",
  unsignedAnswer:
    "An earlier answer in this conversation is missing its signature or was changed, so the agent can't continue it. Reload the page to start a new conversation.",
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
  /** Signs the chat's answers and checks the earlier ones a request sends back. */
  answerSigner: AnswerSigner;
  /**
   * Per-IP limits: in the shared store when `AGENT_STORE` selects one, else
   * in memory, per instance (`rate-limit.ts`).
   */
  chatRateLimiter: RateLimiter;
  mcpRateLimiter: RateLimiter;
  /** Monthly spend cap on the model; shared or in memory like the limits (`spend-cap.ts`). */
  spendCap: SpendCap;
  /** Per-key daily spend quota on `/chat`; shared or in memory like the limits (`daily-quota.ts`). */
  dailyQuota: DailyQuota;
  /** Weekly usage aggregates served by `/stats`; in the same store (`usage.ts`). */
  usage: UsageRecorder;
  /** Notes the provider's own spend limit, for its alert event; in the same store (`provider-limit.ts`). */
  providerLimit: ProviderLimitWatch;
  /** Key for the `/chat` and `/stats` rate limits: the client IP, or its `/64` for IPv6, in production. */
  rateLimitKey: (c: Context) => string;
  /** Key for the `/mcp` rate limit: the client IP (or its `/64`), through the Hosting rewrite too. */
  mcpRateLimitKey: (c: Context) => string;
  /**
   * Whether a `/mcp` request's right-most hop is a Google address outside the
   * user-triggered fetchers ranges: the sign the ranges snapshot is stale.
   */
  isUnknownGoogleHop: (c: Context) => boolean;
};

const jsonError = (
  c: Context,
  status: 400 | 413 | 429 | 503,
  error: HttpErrorBody["error"],
) => c.json<HttpErrorBody>({ error }, status);

/**
 * A JSON-RPC error, as `/mcp` answers whatever it refuses before the MCP
 * server runs, so MCP clients can surface it. `data.code` is the HTTP error
 * code the chat would use.
 */
const jsonRpcError = (
  c: Context,
  status: 429 | 503,
  code: number,
  message: string,
  data: { code: HttpErrorCode; retryAfterSeconds?: number },
) => c.json({ jsonrpc: "2.0", id: null, error: { code, message, data } }, status);

/** How each route answers an error it didn't handle, in its own error contract. */
const unhandledErrorResponders: Record<string, (c: Context) => Response> = {
  [paths.chat]: (c) => {
    logUnrecordedChat(503);
    return jsonError(c, 503, { code: "unavailable", message: errorMessages.unavailable });
  },
  [paths.mcp]: (c) =>
    jsonRpcError(c, 503, -32603, errorMessages.unavailable, { code: "unavailable" }),
  [paths.stats]: (c) =>
    jsonError(c, 503, { code: "unavailable", message: httpErrorMessages.statsUnavailable }),
};

const unhandledErrorFallback = (c: Context) =>
  jsonError(c, 503, { code: "unavailable", message: errorMessages.unavailable });

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
      logStoreError("rate_limit", `Rate limit: store failed, letting ${c.req.path} through`, error, {
        route: c.req.path,
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
 * Logs a chat request the usage stats don't record: refused as invalid
 * (`400`, `413`), or failed closed on a store error (`503`). Every other one
 * is logged as it's recorded (`usage.ts`).
 */
function logUnrecordedChat(status: 400 | 413 | 503) {
  logChatRequest({ outcome: `http_${status}` });
}

/**
 * The conversation in the body, as the chat agent reads it, or the `400` that
 * refuses it: malformed, or an earlier answer unsigned or changed.
 */
async function parseChatRequest(
  c: Context,
  answerSigner: AnswerSigner,
): Promise<ChatMessage[] | Response> {
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
  const messages = answerSigner.verify(parsed.data.messages);
  if (!messages) {
    return jsonError(c, 400, { code: "invalid_request", message: httpErrorMessages.unsignedAnswer });
  }
  return messages;
}

export function createApp(deps: AppDeps): Hono {
  const {
    toolset,
    modelClient,
    allowedOrigins,
    chatLimits,
    answerSigner,
    chatRateLimiter,
    mcpRateLimiter,
    spendCap,
    dailyQuota,
    usage,
    providerLimit,
    rateLimitKey,
    mcpRateLimitKey,
    isUnknownGoogleHop,
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
        logStoreError("usage_stats", "Usage: could not read the stats", error);
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

  // Counted before the limit: if Hosting's peer has left the fetchers ranges,
  // its visitors share one key, so most of them are refused. Only the count.
  app.use(paths.mcp, async (c, next) => {
    if (isUnknownGoogleHop(c)) usage.countUnknownGoogleHop();
    await next();
  });

  // Per-IP limit. Answered as a JSON-RPC error so MCP clients can surface it.
  app.use(
    paths.mcp,
    rateLimit(mcpRateLimiter, mcpRateLimitKey, "open", (c, retryAfterSeconds) =>
      jsonRpcError(c, 429, -32000, httpErrorMessages.rateLimited, {
        code: "rate_limited",
        retryAfterSeconds,
      }),
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
    // Not awaited: the answer doesn't wait on the weekly document, which every
    // request writes. The recorder never throws.
    void usage.recordMcp();
    return transport.handleRequest(c.req.raw);
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
        logUnrecordedChat(413);
        return jsonError(c, 413, { code: "invalid_request", message: "Request body is too large." });
      },
    }),
    async (c) => {
      const messages = await parseChatRequest(c, answerSigner);
      if (messages instanceof Response) {
        logUnrecordedChat(400);
        return messages;
      }
      if (!chatAgent) {
        await usage.recordChat({ outcome: "http_503" });
        return jsonError(c, 503, { code: "unavailable", message: errorMessages.unavailable });
      }
      // Reserve the most this request can cost while it runs, against the
      // key's daily quota and then the month's spend cap (see spend-holds.ts).
      // The quota first: its document is the key's own, so a key over it
      // never touches the month's shared one.
      const worstCase = chatAgent.worstCaseUsage(messages);
      const quota = await dailyQuota.reserve(rateLimitKey(c), worstCase);
      if (quota.exceeded) {
        await usage.recordChat({ outcome: "http_429" });
        c.header("Retry-After", String(quota.retryAfterSeconds));
        return jsonError(c, 429, {
          code: "rate_limited",
          message: httpErrorMessages.dailyQuota,
          retryAfterSeconds: quota.retryAfterSeconds,
          resetsAt: quota.resetsAt,
        });
      }
      const spend = await spendCap.reserve(worstCase);
      if (spend.exhausted) {
        await quota.reservation.settle();
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
      // The answer is signed as it ends, so it can come back in the next
      // chat request (answer-signing.ts).
      const events = answerSigner.signEvents(meteredChat(messages, {
        agent: chatAgent,
        reservation: combineReservations(quota.reservation, spend.reservation),
        usage,
        startedAt: c.get("chatStartedAt"),
        signal: abort.signal,
      }));
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
    return (unhandledErrorResponders[c.req.path] ?? unhandledErrorFallback)(c);
  });

  return app;
}
