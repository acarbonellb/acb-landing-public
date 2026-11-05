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
      maxModelCalls: chatLimits.maxModelCalls,
      maxTokens: chatLimits.maxTokens,
      maxRequestTokens: chatLimits.maxRequestTokens,
    });
  });

  it("reads the contact email from CONTACT_EMAIL, and has none without it", () => {
    expect(loadConfig({ CONTACT_EMAIL: "ada@example.com" }).contactEmail).toBe("ada@example.com");
    expect(loadConfig({}).contactEmail).toBeUndefined();
    expect(loadConfig({ CONTACT_EMAIL: "" }).contactEmail).toBeUndefined();
  });

  it("trims CONTACT_EMAIL, so a secret saved with a trailing newline still works", () => {
    expect(loadConfig({ CONTACT_EMAIL: "ada@example.com\n" }).contactEmail).toBe("ada@example.com");
    expect(loadConfig({ CONTACT_EMAIL: "  ada@example.com \r\n" }).contactEmail).toBe(
      "ada@example.com",
    );
    expect(loadConfig({ CONTACT_EMAIL: "\n" }).contactEmail).toBeUndefined();
  });

  it("rejects a CONTACT_EMAIL that isn't an address, without echoing it", () => {
    expect(() => loadConfig({ CONTACT_EMAIL: "not-an-address" })).toThrow(/CONTACT_EMAIL/);
    expect(() => loadConfig({ CONTACT_EMAIL: "not-an-address" })).not.toThrow(/not-an-address/);
  });

  it("reads the API key from ANTHROPIC_API_KEY, and has none without it", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "test-key" }).anthropicApiKey).toBe("test-key");
    expect(loadConfig({}).anthropicApiKey).toBeUndefined();
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
      chatLimits: { maxTokens: 2048, maxModelCalls: 3 },
      allowedOrigins: ["https://a.example", "http://localhost:4173"],
    });
  });

  it("defaults the guardrails: per-IP limits, global ceilings well above them, a $4 monthly cap (under the $5 provider limit), Haiku 5.5 prices", () => {
    expect(loadConfig({}).guardrails).toEqual({
      chatRequestsPerMinute: 10,
      mcpRequestsPerMinute: 60,
      chatGlobalRequestsPerMinute: 60,
      mcpGlobalRequestsPerMinute: 600,
      monthlyBudgetUsd: 4,
      pricing: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
    });
  });

  it("reads guardrail overrides; a zero budget is allowed (chat off)", () => {
    const config = loadConfig({
      RATE_LIMIT_CHAT_PER_MINUTE: "5",
      RATE_LIMIT_MCP_PER_MINUTE: "100",
      RATE_LIMIT_CHAT_GLOBAL_PER_MINUTE: "30",
      RATE_LIMIT_MCP_GLOBAL_PER_MINUTE: "300",
      MONTHLY_SPEND_CAP_USD: "0",
      AGENT_PRICE_INPUT_USD_PER_MTOK: "2",
      AGENT_PRICE_OUTPUT_USD_PER_MTOK: "10",
    });
    expect(config.guardrails).toEqual({
      chatRequestsPerMinute: 5,
      mcpRequestsPerMinute: 100,
      chatGlobalRequestsPerMinute: 30,
      mcpGlobalRequestsPerMinute: 300,
      monthlyBudgetUsd: 0,
      pricing: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
    });
    expect(() => loadConfig({ MONTHLY_SPEND_CAP_USD: "-1" })).toThrow(/MONTHLY_SPEND_CAP_USD/);
  });

  it("defaults the prices to the configured model's list prices", () => {
    expect(loadConfig({ AGENT_MODEL: "claude-sonnet-5-5" }).guardrails.pricing).toEqual({
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheReadUsdPerMTok: 0.1,
    });
  });

  it("fails for a model with no list price unless both prices are explicit", () => {
    expect(() => loadConfig({ AGENT_MODEL: "claude-future-9" })).toThrow(/claude-future-9/);
    expect(() =>
      loadConfig({ AGENT_MODEL: "claude-future-9", AGENT_PRICE_INPUT_USD_PER_MTOK: "1" }),
    ).toThrow(/AGENT_PRICE_OUTPUT_USD_PER_MTOK/);
    const config = loadConfig({
      AGENT_MODEL: "claude-future-9",
      AGENT_PRICE_INPUT_USD_PER_MTOK: "1",
      AGENT_PRICE_OUTPUT_USD_PER_MTOK: "5",
    });
    expect(config.guardrails.pricing).toEqual({ inputUsdPerMTok: 1, outputUsdPerMTok: 5 });
  });

  it("rejects invalid values instead of silently ignoring them", () => {
    expect(() => loadConfig({ AGENT_MAX_TOKENS: "lots" })).toThrow(/AGENT_MAX_TOKENS/);
    expect(() => loadConfig({ AGENT_EFFORT: "extreme" })).toThrow(/AGENT_EFFORT/);
  });

  it("reads the per-request output-token budget", () => {
    expect(loadConfig({}).chatLimits.maxRequestTokens).toBe(chatLimits.maxRequestTokens);
    expect(
      loadConfig({ AGENT_MAX_REQUEST_TOKENS: "3000" }).chatLimits.maxRequestTokens,
    ).toBe(3000);
  });

  it("is plain data: no functions, nothing built", () => {
    const config = loadConfig({
      ANTHROPIC_API_KEY: "test-key",
      AGENT_STORE: "firestore",
      FIRESTORE_PROJECT_ID: "acb-landing",
    });
    expect(structuredClone(config)).toEqual(config);
  });

  it("keeps the guardrails' state in memory by default", () => {
    expect(loadConfig({}).store).toEqual({ kind: "memory" });
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
