import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { liveRunConfig } from "./live-run";

describe("liveRunConfig (what `pnpm agent:eval` records with)", () => {
  it("defaults to LM Studio on localhost, free, with the agent's default effort", () => {
    expect(liveRunConfig({})).toEqual({
      baseURL: "http://localhost:1234",
      local: true,
      provider: "lmstudio",
      model: "qwen/qwen3.5-9b",
      apiKey: "lmstudio",
      effort: loadConfig({}).effort,
    });
  });

  it("reads the model, effort and key through the agent's config schema", () => {
    const env = {
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_API_KEY: "sk-test",
      AGENT_MODEL: "claude-haiku-5-5",
      AGENT_EFFORT: "medium",
    };

    expect(liveRunConfig(env)).toEqual({
      baseURL: "https://api.anthropic.com",
      local: false,
      provider: "anthropic",
      model: "claude-haiku-5-5",
      apiKey: "sk-test",
      effort: "medium",
    });
    expect(liveRunConfig({ ...env, AGENT_EVAL_PROVIDER: "proxy" }).provider).toBe("proxy");
    expect(liveRunConfig(env, { provider: "flag" }).provider).toBe("flag");
  });

  it("fails on an invalid setting exactly as the agent does", () => {
    const env = { AGENT_EFFORT: "extreme" };
    const agentError = (() => {
      try {
        loadConfig(env);
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(agentError).toMatch(/^Invalid agent configuration: .*AGENT_EFFORT/s);
    expect(() => liveRunConfig(env)).toThrow(agentError);
  });

  it("has no key for a paid server without one", () => {
    expect(liveRunConfig({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }).apiKey).toBeUndefined();
  });
});
