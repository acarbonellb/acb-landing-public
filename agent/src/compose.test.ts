import { describe, expect, it } from "vitest";
import { composeAppDeps, createDocumentStore } from "./compose";
import { loadConfig } from "./config";

describe("composeAppDeps", () => {
  it("has no model client without an API key", () => {
    expect(composeAppDeps(loadConfig({})).modelClient).toBeNull();
  });

  it("builds a model client when an API key is set (without calling the API)", () => {
    const deps = composeAppDeps(loadConfig({ ANTHROPIC_API_KEY: "test-key" }));
    expect(deps.modelClient).not.toBeNull();
  });

  it("gives the tools the configured contact email, and none without it", () => {
    const withEmail = composeAppDeps(loadConfig({ CONTACT_EMAIL: "ada@example.com" }));
    expect(withEmail.toolset.call("get_contact", {})).toMatchObject({ email: "ada@example.com" });
    expect(composeAppDeps(loadConfig({})).toolset.call("get_contact", {})).not.toHaveProperty(
      "email",
    );
  });

  it("keeps the guardrails' state in memory by default, with no cloud dependency", async () => {
    const config = loadConfig({});
    expect(createDocumentStore(config.store)).toBeNull();

    const deps = composeAppDeps(config);
    expect(await deps.chatRateLimiter.hit("203.0.113.7")).toMatchObject({ allowed: true });
    expect(await deps.usage.stats()).toBeDefined();
  });

  it("selects the shared Firestore store when configured", () => {
    const config = loadConfig({ AGENT_STORE: "firestore", FIRESTORE_PROJECT_ID: "acb-landing" });
    expect(createDocumentStore(config.store)).not.toBeNull();
  });
});
