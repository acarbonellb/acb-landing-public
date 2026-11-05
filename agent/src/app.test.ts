import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  experience,
  profile,
  skillGroups,
} from "../../src/content/profile";
import { fetchContactEmail } from "../../src/lib/mcp-contact";
import { createApp } from "./app";
import { listen, type RunningServer } from "./server";
import { createToolset, siteContent } from "./tools";

// A placeholder: the real address is never in the repo (#51).
const contactEmail = "ada@example.com";

async function connectClient(baseUrl: string) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl)),
  );
  return client;
}

describe("agent service over HTTP", () => {
  let server: RunningServer;
  let client: Client;

  beforeAll(async () => {
    // Production config: the address comes from the environment.
    vi.stubEnv("CONTACT_EMAIL", contactEmail);
    server = await listen(createApp(), 0);
    client = await connectClient(server.url);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await client.close();
    await server.close();
  });

  it("answers the health check", async () => {
    const res = await fetch(new URL("/health", server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  describe("MCP endpoint", () => {
    it("lists the five tools with typed input and output schemas", async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "get_contact",
        "get_experience",
        "get_profile",
        "get_projects",
        "get_stack",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
      const projects = tools.find((t) => t.name === "get_projects");
      expect(projects?.inputSchema.properties?.status).toMatchObject({
        enum: ["in-progress", "offline-evals", "coming-soon", "personal-project"],
      });
    });

    it("get_profile returns the landing's profile", async () => {
      const result = await client.callTool({ name: "get_profile" });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        name: profile.name,
        title: profile.title,
        location: profile.location,
        summary: profile.summary,
      });
    });

    it("get_experience returns the landing's roles", async () => {
      const result = await client.callTool({ name: "get_experience" });
      const { roles } = result.structuredContent as {
        roles: { company: string; highlights: string[] }[];
      };
      expect(roles.map((r) => r.company)).toEqual(
        experience.map((r) => r.company),
      );
      expect(roles[0].highlights).toEqual(experience[0].highlights);
    });

    it("get_experience filters by company", async () => {
      const result = await client.callTool({
        name: "get_experience",
        arguments: { company: experience[1].company.toLowerCase() },
      });
      const { roles } = result.structuredContent as {
        roles: { company: string }[];
      };
      expect(roles.map((r) => r.company)).toEqual([experience[1].company]);
    });

    it("get_projects returns the landing's agents", async () => {
      const result = await client.callTool({ name: "get_projects" });
      const { projects } = result.structuredContent as {
        projects: { name: string; status: string }[];
      };
      expect(projects.map((p) => [p.name, p.status])).toEqual(
        agents.map((a) => [a.name, a.status]),
      );
    });

    it("get_stack returns the landing's skill groups", async () => {
      const result = await client.callTool({ name: "get_stack" });
      expect(result.structuredContent).toEqual({
        groups: skillGroups.map(({ key, label, items }) => ({
          key,
          label,
          items,
        })),
      });
    });

    it("get_contact returns the CONTACT_EMAIL address and the landing's links", async () => {
      const result = await client.callTool({ name: "get_contact" });
      expect(result.structuredContent).toMatchObject({
        email: contactEmail,
        github: profile.links.github,
        linkedin: profile.links.linkedin,
      });
    });

    // The site's contact fallback (#50): one bare `tools/call` from another
    // origin, no session or `initialize` first.
    it("answers the site's contact lookup from another origin, without a session", async () => {
      const seen: Response[] = [];
      const fetchFromSite: typeof fetch = async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Origin", "https://albertocarbonell.dev");
        const res = await fetch(url, { ...init, headers });
        seen.push(res);
        return res;
      };

      const email = await fetchContactEmail(new URL("/mcp", server.url).href, {
        fetch: fetchFromSite,
      });

      expect(email).toBe(contactEmail);
      expect(seen[0].headers.get("access-control-allow-origin")).toBe("*");
    });

    it("also returns the result as JSON text for clients without structured content", async () => {
      const result = await client.callTool({ name: "get_contact" });
      const [first] = result.content as { type: string; text: string }[];
      expect(first.type).toBe("text");
      expect(JSON.parse(first.text)).toEqual(result.structuredContent);
    });

    it("rejects invalid input", async () => {
      const result = await client.callTool({
        name: "get_projects",
        arguments: { status: "abandoned" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    });

    it("rejects unknown arguments", async () => {
      const result = await client.callTool({
        name: "get_profile",
        arguments: { salary: true },
      });
      expect(result.isError).toBe(true);
    });

    it("rejects an unknown tool", async () => {
      const result = await client
        .callTool({ name: "get_salary" })
        .catch((error: Error) => ({ isError: true, error }));
      expect(result.isError).toBe(true);
    });
  });
});

describe("without CONTACT_EMAIL (local development)", () => {
  it("get_contact gives no email, and the site's lookup falls back", async () => {
    vi.stubEnv("CONTACT_EMAIL", "");
    const server = await listen(createApp(), 0);
    const client = await connectClient(server.url);
    try {
      const result = await client.callTool({ name: "get_contact" });
      expect(result.structuredContent).not.toHaveProperty("email");
      expect(result.structuredContent).toMatchObject({ linkedin: profile.links.linkedin });
      expect(await fetchContactEmail(new URL("/mcp", server.url).href)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      await client.close();
      await server.close();
    }
  });
});

describe("dependencies are injectable", () => {
  it("serves the toolset it is given", async () => {
    const toolset = createToolset({
      ...siteContent,
      profile: { ...siteContent.profile, name: "Test Person" },
    });
    const server = await listen(createApp({ toolset }), 0);
    const client = await connectClient(server.url);
    try {
      const result = await client.callTool({ name: "get_contact" });
      expect(result.structuredContent).toMatchObject({ name: "Test Person" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
