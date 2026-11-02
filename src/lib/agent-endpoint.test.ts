import { describe, expect, it } from "vitest";
import { agentEndpoints } from "./agent-endpoint";

describe("agentEndpoints", () => {
  it("defaults to the local agent service outside production builds", () => {
    const local = {
      chat: "http://localhost:8080/chat",
      mcp: "http://localhost:8080/mcp",
    };
    expect(agentEndpoints(undefined, "development")).toEqual(local);
    expect(agentEndpoints("", "test")).toEqual(local);
  });

  it("uses the configured base URL, with or without a trailing slash", () => {
    expect(agentEndpoints("https://agent.example.dev/", "production")).toEqual({
      chat: "https://agent.example.dev/chat",
      mcp: "https://agent.example.dev/mcp",
    });
  });

  it("has no agent in a production build without a configured URL", () => {
    expect(agentEndpoints(undefined, "production")).toBeNull();
    expect(agentEndpoints("", "production")).toBeNull();
  });
});
