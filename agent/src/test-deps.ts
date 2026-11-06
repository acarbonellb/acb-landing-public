// App dependencies for tests: the memory adapters and the fake model, with the
// same limits production has by default, whatever the shell's environment.
// The guardrails are wired by the composition root, as in production with no
// shared store.
import type { ChatMessage, ChatRequestMessage } from "../../src/shared/chat-contract";
import { createAnswerSigner } from "./answer-signing";
import type { AppDeps } from "./app";
import { mcpRateLimitKey, mcpUnknownGoogleHop, rateLimitKey } from "./client-ip";
import { createGuardrails } from "./compose";
import { loadConfig } from "./config";
import { createFakeModel } from "./fake-model";
import { createToolset } from "./tools";

/** The fixed key the tests' answers are signed with. */
export const testSigningKey = "test-answer-signing-key-0123456789abcdef";

/**
 * `messages` as the site sends them back: each answer signed with the test
 * key, in one conversation, at its place.
 */
export function signedConversation(messages: ChatMessage[]): ChatRequestMessage[] {
  const signer = createAnswerSigner(testSigningKey);
  const conversation = "test-conversation-0001";
  let position = 0;
  return messages.map((m, i) =>
    m.role === "user"
      ? { role: "user", content: m.content }
      : {
          role: "assistant",
          content: m.content,
          signature: signer.sign(
            { conversation, position: ++position, question: messages[i - 1]?.content ?? "" },
            m.content,
          ),
        },
  );
}

/** The configuration with no environment: the code defaults. */
const defaults = loadConfig({});

/**
 * Every dependency in memory, with a fake model that has nothing scripted;
 * `overrides` replace any of them.
 */
export function testAppDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    toolset: createToolset(),
    modelClient: createFakeModel([]),
    allowedOrigins: defaults.allowedOrigins,
    chatLimits: defaults.chatLimits,
    answerSigner: createAnswerSigner(testSigningKey),
    ...createGuardrails(null, defaults),
    rateLimitKey,
    mcpRateLimitKey,
    isUnknownGoogleHop: mcpUnknownGoogleHop,
    ...overrides,
  };
}
