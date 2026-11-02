import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import * as z from "zod";
import { chatRequestSchema, errorMessages, runChat } from "./chat";
import { loadConfig } from "./config";
import { createMcpServer } from "./mcp";
import type { ModelClient } from "./model";
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
};

/** Error codes of non-streamed (JSON) chat responses. */
export type HttpErrorCode = "invalid_request" | "unavailable";

const jsonError = (
  c: Context,
  status: 400 | 413 | 503,
  code: HttpErrorCode,
  message: string,
) => c.json({ error: { code, message } }, status);

export function createApp(deps: Partial<AppDeps> = {}): Hono {
  const config = loadConfig();
  const {
    toolset = createToolset(),
    allowedOrigins = config.allowedOrigins,
    chatLimits = config.chatLimits,
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
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
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
      maxAge: 600,
    }),
  );

  app.post(
    paths.chat,
    bodyLimit({
      maxSize: maxChatBodyBytes,
      onError: (c) =>
        jsonError(c, 413, "invalid_request", "Request body is too large."),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return jsonError(c, 400, "invalid_request", "Request body must be JSON.");
      }
      const parsed = chatRequestSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(c, 400, "invalid_request", z.prettifyError(parsed.error));
      }
      if (!modelClient) {
        return jsonError(c, 503, "unavailable", errorMessages.unavailable);
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
          if (stream.aborted) break;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
      });
    },
  );

  return app;
}
