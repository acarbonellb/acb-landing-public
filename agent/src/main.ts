import { createApp, paths } from "./app";
import { composeAppDeps } from "./compose";
import { loadConfig } from "./config";
import { listen } from "./server";
import { closeOnSignals } from "./shutdown";

const config = loadConfig();
const port = Number(process.env.PORT ?? 8080);
const deps = composeAppDeps(config);
const server = await listen(createApp(deps), port);

console.log(`Agent service listening on ${server.url}`);
console.log(`MCP endpoint: ${server.url}${paths.mcp}`);
console.log(`Chat endpoint: ${server.url}${paths.chat}`);
if (!config.anthropicApiKey) {
  console.warn("ANTHROPIC_API_KEY is not set: the chat endpoint answers 503.");
}
if (!config.answerSigningKey) {
  console.warn(
    "ANSWER_SIGNING_KEY is not set: answers are signed with a key of this process only, so a restart refuses earlier ones.",
  );
}
if (!config.contactEmail) {
  console.warn("CONTACT_EMAIL is not set: get_contact offers LinkedIn and GitHub only.");
}

closeOnSignals(process, { server, usage: deps.usage, exit: (code) => process.exit(code) });
