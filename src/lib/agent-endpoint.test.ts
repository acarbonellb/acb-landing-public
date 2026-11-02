import { describe, expect, it } from "vitest";
import { agentEndpoints } from "./agent-endpoint";

describe("agentEndpoints", () => {
  it("defaults to the local agent service", () => {
    expect(agentEndpoints(undefined)).toEqual({
      chat: "http://localhost:8080/chat",
      mcp: "http://localhost:8080/mcp",
    });
    expect(agentEndpoints("")).toEqual(agentEndpoints(undefined));
  });

  it("uses the configured base URL, with or without a trailing slash", () => {
    expect(agentEndpoints("https://agent.example.dev/")).toEqual({
      chat: "https://agent.example.dev/chat",
      mcp: "https://agent.example.dev/mcp",
    });
  });
});
