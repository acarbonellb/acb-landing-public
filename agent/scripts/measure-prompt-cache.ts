// Does prompt caching ever trigger on the chat's prompt? One real, billed
// model call (well under a cent on the default model) with the production
// system prompt, tools, model, effort and output cap, through the production
// client (which sends `cache_control`). Prints the call's input usage.
//
//   ANTHROPIC_API_KEY=... pnpm agent:cache:measure --paid
//
// A cache write or read above 0 means caching triggers: keep `cache_control`.
// Both 0 means the prompt is under the model's minimum cacheable length and
// caching never happens: remove it. A read above 0 means a call in the last
// five minutes already wrote the same prefix, which also means it triggers.
import { parseArgs } from "node:util";
import { createAnthropicModelClient } from "../src/anthropic";
import { modelTools } from "../src/chat";
import { loadConfig } from "../src/config";
import { systemPrompt } from "../src/system-prompt";
import { createToolset, siteContent } from "../src/tools";

const { values } = parseArgs({ options: { paid: { type: "boolean", default: false } } });
const config = loadConfig();
if (!config.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}
if (!values.paid) {
  console.error(`This makes one billed call to ${config.model}. Pass --paid to run it.`);
  process.exit(1);
}

const client = createAnthropicModelClient({
  apiKey: config.anthropicApiKey,
  model: config.model,
  effort: config.effort,
});
const toolset = createToolset({ ...siteContent, contactEmail: config.contactEmail });
const { maxTokens, maxRequestTokens } = config.chatLimits;

for await (const event of client.stream({
  system: systemPrompt,
  tools: modelTools(toolset),
  messages: [{ role: "user", text: "What does Alberto work on?" }],
  maxTokens: Math.min(maxTokens, maxRequestTokens),
})) {
  if (event.type !== "turn_end") continue;
  const { usage } = event.turn;
  const written = usage.cacheWriteInputTokens ?? 0;
  const read = usage.cacheReadInputTokens ?? 0;
  console.log(`model: ${config.model}`);
  console.log(`input tokens (all): ${usage.inputTokens}`);
  console.log(`  cache_creation_input_tokens: ${written}`);
  console.log(`  cache_read_input_tokens: ${read}`);
  console.log(`  uncached input_tokens: ${usage.inputTokens - written - read}`);
  console.log(`output tokens: ${usage.outputTokens}`);
  console.log(
    written + read > 0
      ? "Caching triggers: keep cache_control."
      : "Nothing cached: the prompt is under the minimum; remove cache_control.",
  );
}
