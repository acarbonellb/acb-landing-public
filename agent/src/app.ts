import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMcpServer } from "./mcp";
import { createToolset, type Toolset } from "./tools";

/** HTTP paths served by the agent service. */
export const paths = {
  health: "/health",
  mcp: "/mcp",
} as const;

/**
 * Everything the service depends on. Tests inject fakes; production uses the
 * defaults. Later tickets add the model client, rate limiter and spend cap.
 */
export type AppDeps = {
  toolset: Toolset;
};

export function createApp(deps: Partial<AppDeps> = {}): Hono {
  const { toolset = createToolset() } = deps;
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

  return app;
}
