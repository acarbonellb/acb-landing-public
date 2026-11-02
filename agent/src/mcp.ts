import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Toolset } from "./tools";

export const serverInfo = { name: "albertocarbonell-portfolio", version: "0.1.0" };

/**
 * An MCP server exposing every tool of the toolset. Read-only and public:
 * tools are annotated as such and never touch anything but the content.
 */
export function createMcpServer(toolset: Toolset): McpServer {
  const server = new McpServer(serverInfo, {
    instructions:
      "Tools that answer questions about Alberto Carbonell, a senior software engineer: profile, work experience, agent projects, tech stack and contact details.",
  });

  for (const tool of toolset.list()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (args) => {
        const output = toolset.call(tool.name, args);
        return {
          structuredContent: output,
          content: [{ type: "text", text: JSON.stringify(output) }],
        };
      },
    );
  }

  return server;
}
