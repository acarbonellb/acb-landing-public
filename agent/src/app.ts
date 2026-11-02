import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import * as z from "zod";
import { chatRequestSchema, errorMessages, runChat } from "./chat";
import { clientIp } from "./client-ip";
import { loadConfig } from "./config";
import { createMcpServer } from "./mcp";
import type { ModelClient } from "./model";
import { createMemoryRateLimiter, type RateLimiter } from "./rate-limit";
import { createMemorySpendCap, type SpendCap } from "./spend-cap";
import { createToolset, type Toolset } from "./tools";

/** HTTP paths served by the agent service. */
export const paths = {
  health: "/health",
  mcp: "/mcp",
  chat: "/chat",
} as const;

/** Largest chat request body accepted, in bytes. */
export const maxChatBodyBytes = 64 * 1024;

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
  chatLimits: { maxIterations: number; maxTokens: number };
  /**
   * Per-IP limits. The defaults keep counts in memory, per instance (see
   * `rate-limit.ts` for what that means on Cloud Run and how to share them).
   */
  chatRateLimiter: RateLimiter;
  mcpRateLimiter: RateLimiter;
  /** Monthly model budget; in memory and per instance by default (`spend-cap.ts`). */
  spendCap: SpendCap;
  /** Key for the rate limiters: the client IP by default. */
  clientKey: (c: Context) => string;
};

/** Error codes of non-streamed (JSON) chat responses. */
export type HttpErrorCode = "invalid_request" | "rate_limited" | "unavailable";

/**
 * Body of every non-streamed chat error. `rate_limited` adds
 * `retryAfterSeconds` (also sent as `Retry-After`); `unavailable` because of
 * the monthly spend cap adds `resetsAt` (ISO time the budget renews).
 */
export type HttpErrorBody = {
  error: {
    code: HttpErrorCode;
    message: string;
    retryAfterSeconds?: number;
    resetsAt?: string;
  };
};

const jsonError = (
  c: Context,
  status: 400 | 413 | 429 | 503,
  error: HttpErrorBody["error"],
) => c.json<HttpErrorBody>({ error }, status);

const minute = 60_000;

export function createApp(deps: Partial<AppDeps> = {}): Hono {
  const config = loadConfig();
  const {
    toolset = createToolset(),
    allowedOrigins = config.allowedOrigins,
    chatLimits = config.chatLimits,
    chatRateLimiter = createMemoryRateLimiter({
      limit: config.guardrails.chatRequestsPerMinute,
      windowMs: minute,
    }),
    mcpRateLimiter = createMemoryRateLimiter({
      limit: config.guardrails.mcpRequestsPerMinute,
      windowMs: minute,
    }),
    spendCap = createMemorySpendCap({
      budgetUsd: config.guardrails.monthlyBudgetUsd,
      pricing: config.guardrails.pricing,
    }),
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
  app.use(paths.mcp, async (c, next) => {
    const decision = await mcpRateLimiter.hit(clientKey(c));
    if (decision.allowed) return next();
    c.header("Retry-After", String(decision.retryAfterSeconds));
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: errorMessages.rateLimited,
          data: { code: "rate_limited", retryAfterSeconds: decision.retryAfterSeconds },
        },
      },
      429,
    );
  });

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
    async (c, next) => {
      const decision = await chatRateLimiter.hit(clientKey(c));
      if (decision.allowed) return next();
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return jsonError(c, 429, {
        code: "rate_limited",
        message: errorMessages.rateLimited,
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    },
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
      const budget = await spendCap.check();
      if (budget.exhausted) {
        return jsonError(c, 503, {
          code: "unavailable",
          message: errorMessages.spendCap,
          resetsAt: budget.resetsAt,
        });
      }

      // A closed connection aborts the model call, so nobody pays for an
      // answer no one reads.
      const signal = c.req.raw.signal;
      return streamSSE(c, async (stream) => {
        for await (const event of runChat({
          model: modelClient,
          toolset,
          messages: parsed.data.messages,
          ...chatLimits,
          signal,
        })) {
          // Every model call is paid for, even if the visitor has left.
          if (event.type === "usage") await spendCap.record(event);
          if (stream.aborted) break;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
      });
    },
  );

  return app;
}
