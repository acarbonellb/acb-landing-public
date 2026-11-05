import { createApp, paths } from "./app";
import { composeAppDeps } from "./compose";
import { loadConfig } from "./config";
import { listen } from "./server";

const config = loadConfig();
const port = Number(process.env.PORT ?? 8080);
const server = await listen(createApp(composeAppDeps(config)), port);

console.log(`Agent service listening on ${server.url}`);
console.log(`MCP endpoint: ${server.url}${paths.mcp}`);
console.log(`Chat endpoint: ${server.url}${paths.chat}`);
if (!config.anthropicApiKey) {
  console.warn("ANTHROPIC_API_KEY is not set: the chat endpoint answers 503.");
}
if (!config.contactEmail) {
  console.warn("CONTACT_EMAIL is not set: get_contact offers LinkedIn and GitHub only.");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
