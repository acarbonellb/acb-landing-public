import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import * as z from "zod";
import type { HttpErrorBody, HttpErrorCode } from "../../src/lib/chat-contract";
import { chatRequestSchema, errorMessages, runChat, worstCaseUsage } from "./chat";
import { clientIp } from "./client-ip";
import { loadConfig } from "./config";
import { createMcpServer } from "./mcp";
import type { ModelClient } from "./model";
import {
  createMemoryRateLimiter,
  createStoreRateLimiter,
  type RateLimiter,
} from "./rate-limit";
import { createMemorySpendCap, createStoreSpendCap, type SpendCap } from "./spend-cap";
import { createToolset, type Toolset } from "./tools";

export type { HttpErrorBody, HttpErrorCode };

/** HTTP paths served by the agent service. */
export const paths = {
  health: "/health",
  mcp: "/mcp",
  chat: "/chat",
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
 * Everything the service depends on. Tests inject fakes; production uses the
 * defaults, read from the environment (see `config.ts`).
 */
export type AppDeps = {
  toolset: Toolset;
  /** `null` when no model is configured: the chat answers 503. */
  modelClient: ModelClient | null;
  /** Browser origins allowed to call the chat endpoint. */
  allowedOrigins: string[];
  chatLimits: { maxIterations: number; maxTokens: number; maxRequestTokens: number };
  /**
   * Per-IP limits. By default in the shared store when `AGENT_STORE` selects
   * one, else in memory, per instance (`rate-limit.ts`).
   */
  chatRateLimiter: RateLimiter;
  mcpRateLimiter: RateLimiter;
  /** Monthly model budget; shared or in memory like the limits (`spend-cap.ts`). */
  spendCap: SpendCap;
  /** Key for the rate limiters: the client IP by default. */
  clientKey: (c: Context) => string;
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
  refuse: (c: Context, retryAfterSeconds: number) => Response,
): MiddlewareHandler {
  return async (c, next) => {
    const decision = await limiter.hit(clientKey(c));
    if (decision.allowed) return next();
    c.header("Retry-After", String(decision.retryAfterSeconds));
    return refuse(c, decision.retryAfterSeconds);
  };
}

const minute = 60_000;

export function createApp(deps: Partial<AppDeps> = {}): Hono {
  const config = loadConfig();
  const store = config.createDocumentStore();
  const rateLimiter = (name: string, limit: number) =>
    store
      ? createStoreRateLimiter({ store, name, limit, windowMs: minute })
      : createMemoryRateLimiter({ limit, windowMs: minute });
  const spendCapOptions = {
    budgetUsd: config.guardrails.monthlyBudgetUsd,
    pricing: config.guardrails.pricing,
  };
  const {
    toolset = createToolset(),
    allowedOrigins = config.allowedOrigins,
    chatLimits = config.chatLimits,
    chatRateLimiter = rateLimiter("chat", config.guardrails.chatRequestsPerMinute),
    mcpRateLimiter = rateLimiter("mcp", config.guardrails.mcpRequestsPerMinute),
    spendCap = store
      ? createStoreSpendCap({ ...spendCapOptions, store })
      : createMemorySpendCap(spendCapOptions),
    clientKey = (c: Context) => clientIp(c, config.guardrails.trustedProxyHops),
  } = deps;
  const modelClient =
    deps.modelClient === undefined ? config.createModelClient() : deps.modelClient;
  const app = new Hono();

  app.get(paths.health, (c) => c.json({ status: "ok" }));

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
    rateLimit(mcpRateLimiter, clientKey, (c, retryAfterSeconds) =>
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
    // Counted before anything else, so malformed requests count too.
    rateLimit(chatRateLimiter, clientKey, (c, retryAfterSeconds) =>
      jsonError(c, 429, {
        code: "rate_limited",
        message: httpErrorMessages.rateLimited,
        retryAfterSeconds,
      }),
    ),
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
        return jsonError(c, 503, { code: "unavailable", message: errorMessages.unavailable });
      }
      const { messages } = parsed.data;
      // Hold the most this request can cost while it runs (see spend-cap.ts).
      const budget = await spendCap.reserve(worstCaseUsage(toolset, messages, chatLimits));
      if (budget.exhausted) {
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
            if (event.type === "usage") await reservation.record(event);
            if (stream.aborted) continue;
            try {
              await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
            } catch {
              stop();
            }
          }
        } finally {
          await reservation.settle();
        }
      });
    },
  );

  return app;
}
