import { describe, expect, it } from "vitest";
import { chatLimits } from "./chat";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("defaults to Claude Haiku 5.5 (the cheapest current model), the site origins and the built-in caps", () => {
    const config = loadConfig({});
    expect(config.model).toBe("claude-haiku-5-5");
    expect(config.allowedOrigins).toEqual([
      "http://localhost:3000",
      "https://albertocarbonell.dev",
    ]);
    expect(config.chatLimits).toEqual({
      maxIterations: chatLimits.maxIterations,
      maxTokens: chatLimits.maxTokens,
      maxRequestTokens: chatLimits.maxRequestTokens,
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

  it("defaults the guardrails: per-IP limits, a $4 monthly cap (under the $5 provider limit), Haiku 5.5 prices, one proxy hop", () => {
    expect(loadConfig({}).guardrails).toEqual({
      chatRequestsPerMinute: 10,
      mcpRequestsPerMinute: 60,
      monthlyBudgetUsd: 4,
      pricing: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
      trustedProxyHops: 1,
    });
  });

  it("reads guardrail overrides; a zero budget is allowed (chat off)", () => {
    const config = loadConfig({
      RATE_LIMIT_CHAT_PER_MINUTE: "5",
      RATE_LIMIT_MCP_PER_MINUTE: "100",
      MONTHLY_SPEND_CAP_USD: "0",
      AGENT_PRICE_INPUT_USD_PER_MTOK: "2",
      AGENT_PRICE_OUTPUT_USD_PER_MTOK: "10",
      TRUSTED_PROXY_HOPS: "2",
    });
    expect(config.guardrails).toEqual({
      chatRequestsPerMinute: 5,
      mcpRequestsPerMinute: 100,
      monthlyBudgetUsd: 0,
      pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
      trustedProxyHops: 2,
    });
    expect(() => loadConfig({ MONTHLY_SPEND_CAP_USD: "-1" })).toThrow(/MONTHLY_SPEND_CAP_USD/);
  });

  it("rejects invalid values instead of silently ignoring them", () => {
    expect(() => loadConfig({ AGENT_MAX_TOKENS: "lots" })).toThrow(/AGENT_MAX_TOKENS/);
    expect(() => loadConfig({ AGENT_EFFORT: "extreme" })).toThrow(/AGENT_EFFORT/);
  });

  it("rejects a TRUSTED_PROXY_HOPS below one (it would trust no proxy entry)", () => {
    for (const hops of ["0", "-1", "abc", "1.5"]) {
      expect(() => loadConfig({ TRUSTED_PROXY_HOPS: hops })).toThrow(/TRUSTED_PROXY_HOPS/);
    }
  });

  it("reads the per-request output-token budget", () => {
    expect(loadConfig({}).chatLimits.maxRequestTokens).toBe(chatLimits.maxRequestTokens);
    expect(
      loadConfig({ AGENT_MAX_REQUEST_TOKENS: "3000" }).chatLimits.maxRequestTokens,
    ).toBe(3000);
  });

  it("keeps the guardrails' state in memory by default, with no cloud dependency", () => {
    const config = loadConfig({});
    expect(config.store).toEqual({ kind: "memory" });
    expect(config.createDocumentStore()).toBeNull();
  });

  it("selects the shared Firestore store, which needs the project", () => {
    expect(() => loadConfig({ AGENT_STORE: "firestore" })).toThrow(/FIRESTORE_PROJECT_ID/);
    expect(() => loadConfig({ AGENT_STORE: "redis" })).toThrow(/AGENT_STORE/);

    const config = loadConfig({ AGENT_STORE: "firestore", FIRESTORE_PROJECT_ID: "acb-landing" });
    expect(config.store).toEqual({
      kind: "firestore",
      projectId: "acb-landing",
      databaseId: "(default)",
      emulatorHost: undefined,
    });
    expect(config.createDocumentStore()).not.toBeNull();
    expect(
      loadConfig({
        AGENT_STORE: "firestore",
        FIRESTORE_PROJECT_ID: "demo-agent",
        FIRESTORE_DATABASE: "agent",
        FIRESTORE_EMULATOR_HOST: "localhost:8081",
      }).store,
    ).toMatchObject({ databaseId: "agent", emulatorHost: "localhost:8081" });
  });
});
