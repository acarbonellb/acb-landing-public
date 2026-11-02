import { createApp, paths } from "./app";
import { listen } from "./server";

const port = Number(process.env.PORT ?? 8080);
const server = await listen(createApp(), port);

console.log(`Agent service listening on ${server.url}`);
console.log(`MCP endpoint: ${server.url}${paths.mcp}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
