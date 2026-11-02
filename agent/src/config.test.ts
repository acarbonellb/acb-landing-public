import { describe, expect, it } from "vitest";
import { chatLimits } from "./chat";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("defaults to the latest Opus, the site origins and the built-in caps", () => {
    const config = loadConfig({});
    expect(config.model).toBe("claude-opus-5-5");
    expect(config.allowedOrigins).toEqual([
      "http://localhost:3000",
      "https://albertocarbonell.dev",
    ]);
    expect(config.chatLimits).toEqual({
      maxIterations: chatLimits.maxIterations,
      maxTokens: chatLimits.maxTokens,
    });
  });

  it("has no model client without an API key", () => {
    expect(loadConfig({}).createModelClient()).toBeNull();
  });

  it("builds a model client when an API key is set (without calling the API)", () => {
    const client = loadConfig({ ANTHROPIC_API_KEY: "test-key" }).createModelClient();
    expect(client).not.toBeNull();
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      AGENT_MODEL: "claude-sonnet-5-5",
      AGENT_EFFORT: "medium",
      AGENT_MAX_TOKENS: "2048",
      AGENT_MAX_ITERATIONS: "3",
      ALLOWED_ORIGINS: "https://a.example, http://localhost:4173",
    });
    expect(config).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "medium",
      chatLimits: { maxTokens: 2048, maxIterations: 3 },
      allowedOrigins: ["https://a.example", "http://localhost:4173"],
    });
  });

  it("rejects invalid values instead of silently ignoring them", () => {
    expect(() => loadConfig({ AGENT_MAX_TOKENS: "lots" })).toThrow(/AGENT_MAX_TOKENS/);
    expect(() => loadConfig({ AGENT_EFFORT: "extreme" })).toThrow(/AGENT_EFFORT/);
  });
});
