import { createApp, paths } from "./app";
import { listen } from "./server";

const port = Number(process.env.PORT ?? 8080);
const server = await listen(createApp(), port);

console.log(`Agent service listening on ${server.url}`);
console.log(`MCP endpoint: ${server.url}${paths.mcp}`);
console.log(`Chat endpoint: ${server.url}${paths.chat}`);
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("ANTHROPIC_API_KEY is not set: the chat endpoint answers 503.");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
