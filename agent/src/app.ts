import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import * as z from "zod";
import type { HttpErrorBody, HttpErrorCode, TokenUsage } from "../../src/shared/chat-contract";
import { chatRequestSchema, errorMessages, runChat, worstCaseUsage } from "./chat";
import { createMcpServer } from "./mcp";
import type { ModelClient } from "./model";
import { addUsage } from "./pricing";
import type { RateLimiter } from "./rate-limit";
import type { SpendCap } from "./spend-cap";
import type { Toolset } from "./tools";
import type { ChatOutcome, UsageRecorder } from "./usage";

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
  chatLimits: { maxIterations: number; maxTokens: number; maxRequestTokens: number };
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
  /** Key for the `/chat` and `/stats` rate limits: the client IP in production. */
  clientKey: (c: Context) => string;
  /** Key for the `/mcp` rate limit: the client IP, through the Hosting rewrite too. */
  mcpClientKey: (c: Context) => string;
};

const jsonError = (
  c: Context,
  status: 400 | 413 | 429 | 503,
  error: HttpErrorBody["error"],
) => c.json<HttpErrorBody>({ error }, status);

/**
 * Per-client rate limit: lets the request through, or sets `Retry-After` and
 * answers with `refuse` (each endpoint words the refusal in its protocol).
 */
function rateLimit(
  limiter: RateLimiter,
  clientKey: (c: Context) => string,
  refuse: (c: Context, retryAfterSeconds: number) => Response | Promise<Response>,
): MiddlewareHandler {
  return async (c, next) => {
    const decision = await limiter.hit(clientKey(c));
    if (decision.allowed) return next();
    c.header("Retry-After", String(decision.retryAfterSeconds));
    return refuse(c, decision.retryAfterSeconds);
  };
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
    clientKey,
    mcpClientKey,
  } = deps;
  const app = new Hono();
  // When each chat request arrived, for its latency (`usage.ts`).
  const chatStartedAt = new WeakMap<Request, number>();

  app.get(paths.health, (c) => c.json({ status: "ok" }));

  // Public usage aggregates (no content, no IPs), read by the site from any
  // origin. Under the MCP rate limit, sharing its per-IP count.
  app.use(paths.stats, cors({ origin: "*", allowMethods: ["GET"] }));
  app.get(
    paths.stats,
    rateLimit(mcpRateLimiter, clientKey, (c) =>
      jsonError(c, 429, { code: "rate_limited", message: httpErrorMessages.rateLimited }),
    ),
    async (c) => {
      try {
        const body = await usage.stats();
        c.header("Cache-Control", "public, max-age=300");
        return c.json(body);
      } catch (error) {
        console.error("Usage: could not read the stats", error);
        return jsonError(c, 503, { code: "unavailable", message: "Usage stats are unavailable." });
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
    rateLimit(mcpRateLimiter, mcpClientKey, (c, retryAfterSeconds) =>
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
    async (c, next) => {
      chatStartedAt.set(c.req.raw, performance.now());
      await next();
    },
    // Counted before anything else, so malformed requests count too.
    rateLimit(chatRateLimiter, clientKey, async (c, retryAfterSeconds) => {
      await usage.recordChat({ outcome: "http_429" });
      return jsonError(c, 429, {
        code: "rate_limited",
        message: httpErrorMessages.rateLimited,
        retryAfterSeconds,
      });
    }),
    bodyLimit({
      maxSize: maxChatBodyBytes,
      onError: (c) =>
        jsonError(c, 413, { code: "invalid_request", message: "Request body is too large." }),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return jsonError(c, 400, {
          code: "invalid_request",
          message: "Request body must be JSON.",
        });
      }
      const parsed = chatRequestSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(c, 400, {
          code: "invalid_request",
          message: z.prettifyError(parsed.error),
        });
      }
      if (!modelClient) {
        await usage.recordChat({ outcome: "http_503" });
        return jsonError(c, 503, { code: "unavailable", message: errorMessages.unavailable });
      }
      const { messages } = parsed.data;
      // Hold the most this request can cost while it runs (see spend-cap.ts).
      const budget = await spendCap.reserve(worstCaseUsage(toolset, messages, chatLimits));
      if (budget.exhausted) {
        await usage.recordChat({ outcome: "http_503" });
        return jsonError(c, 503, {
          code: "unavailable",
          message: httpErrorMessages.spendCap,
          resetsAt: budget.resetsAt,
        });
      }
      const { reservation } = budget;

      // A closed connection aborts the model call, so nobody pays for an
      // answer no one reads.
      const abort = new AbortController();
      const stop = () => abort.abort();
      c.req.raw.signal.addEventListener("abort", stop, { once: true });
      const startedAt = chatStartedAt.get(c.req.raw) ?? performance.now();
      const elapsed = () => Math.round(performance.now() - startedAt);
      // What `usage.ts` records once the stream ends: no content.
      let outcome: ChatOutcome = "aborted";
      let firstTextMs: number | undefined;
      const spent: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      return streamSSE(c, async (stream) => {
        stream.onAbort(stop);
        try {
          for await (const event of runChat({
            model: modelClient,
            toolset,
            messages,
            ...chatLimits,
            signal: abort.signal,
          })) {
            // Every model call is paid for, even if the visitor has left: keep
            // draining after an abort, as the cut-off call still reports its
            // (estimated) usage.
            if (event.type === "usage") {
              await reservation.record(event);
              addUsage(spent, event);
            }
            if (event.type === "text") firstTextMs ??= elapsed();
            if (event.type === "done") outcome = event.stopReason;
            if (event.type === "error") outcome = `error:${event.code}`;
            if (stream.aborted) continue;
            try {
              await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
            } catch {
              stop();
            }
          }
        } finally {
          await reservation.settle();
          await usage.recordChat({ outcome, usage: spent, totalMs: elapsed(), firstTextMs });
        }
      });
    },
  );

  return app;
}
