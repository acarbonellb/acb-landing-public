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

  it("chats with the configured agent URL and shows MCP on the site's own domain in production", () => {
    const deployed = {
      chat: "https://agent.example.dev/chat",
      mcp: "https://albertocarbonell.dev/mcp",
    };
    expect(agentEndpoints("https://agent.example.dev", "production")).toEqual(deployed);
    expect(agentEndpoints("https://agent.example.dev/", "production")).toEqual(deployed);
  });

  it("uses the configured agent URL for both outside production builds (no rewrite there)", () => {
    expect(agentEndpoints("http://localhost:9000/", "development")).toEqual({
      chat: "http://localhost:9000/chat",
      mcp: "http://localhost:9000/mcp",
    });
  });

  it("has no agent in a production build without a configured URL", () => {
    expect(agentEndpoints(undefined, "production")).toBeNull();
    expect(agentEndpoints("", "production")).toBeNull();
  });
});
