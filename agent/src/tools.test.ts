import { describe, expect, it } from "vitest";
import * as z from "zod";
import { chatPrivacyNote } from "../../src/shared/site-copy";
import { systemPrompt } from "./system-prompt";
import { createToolset, type Content } from "./tools";

const fixture: Content = {
  profile: {
    name: "Ada Lovelace",
    handle: "ada",
    title: "Analyst",
    location: "London",
    tagline: "Notes on the engine.",
    summary: ["First paragraph.", "Second paragraph."],
    contactNote: "Write to me.",
    links: {
      github: "https://github.com/ada",
      linkedin: "https://www.linkedin.com/in/ada/",
    },
  },
  agentProjects: [
    {
      slug: "engine",
      name: "Engine Agent",
      status: "personal-project",
      context: "Personal project",
      description: "Computes Bernoulli numbers.",
      stack: ["Punch cards"],
      href: "#agent",
      links: [
        { label: "source", href: "https://example.com/engine" },
        { label: "the chat", href: "#agent" },
      ],
    },
    {
      slug: "loom",
      name: "Loom Agent",
      status: "offline-evals",
      context: "Side business",
      description: "Weaves patterns.",
      result: "Offline evals: wrong patterns fell from 40% to 5%.",
      resultDetail: "Mean of 3 runs.",
      stack: ["Jacquard"],
    },
  ],
  practices: [
    {
      title: "Tables checked twice",
      text: "Every table is recomputed by hand.",
      sources: [
        { label: "the notes", href: "https://example.com/notes" },
        { label: "Loom Agent", href: "#agent-loom" },
      ],
    },
    {
      title: "A human turns the crank",
      text: "The engine proposes, the operator decides.",
      sources: [{ label: "Loom Agent", href: "#agent-loom" }],
    },
  ],
  experience: [
    {
      slug: "engine-co",
      hash: "abc1234",
      company: "Engine Co",
      role: "Analyst",
      place: "London",
      period: { from: 1842, to: null },
      description: "Builds engines.",
      highlights: ["Wrote the first program."],
      stack: ["Punch cards"],
    },
    {
      slug: "society",
      hash: "def5678",
      company: "Royal Society",
      role: "Translator",
      place: "London",
      period: { from: 1840, to: 1842 },
      highlights: ["Translated Menabrea."],
      stack: ["French"],
    },
  ],
  skillGroups: [
    { key: "math", label: "Mathematics", items: ["Calculus", "Analysis"] },
    { key: "machines", label: "Machines", items: ["Difference engine"] },
  ],
  education: [
    {
      title: "Private tutoring",
      school: "Home",
      place: "London",
      period: { from: 1820, to: 1835 },
    },
  ],
  languages: [{ name: "English", level: "Native" }],
  contactEmail: "ada@example.com",
};

const tools = createToolset(fixture);

describe("toolset", () => {
  it("lists the five profile tools, each with a description", () => {
    expect(tools.list().map((t) => t.name)).toEqual([
      "get_profile",
      "get_experience",
      "get_projects",
      "get_stack",
      "get_contact",
    ]);
    for (const tool of tools.list()) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown tool", () => {
    expect(() => tools.call("get_salary", {})).toThrow(/unknown tool/i);
  });
});

describe("get_profile", () => {
  it("returns who the person is, education and languages", () => {
    expect(tools.call("get_profile", {})).toEqual({
      name: "Ada Lovelace",
      title: "Analyst",
      location: "London",
      tagline: "Notes on the engine.",
      summary: ["First paragraph.", "Second paragraph."],
      education: [
        {
          title: "Private tutoring",
          school: "Home",
          place: "London",
          period: "1820 — 1835",
        },
      ],
      languages: [{ name: "English", level: "Native" }],
    });
  });

  it("rejects unexpected arguments", () => {
    expect(() => tools.call("get_profile", { verbose: true })).toThrow();
  });
});

describe("get_experience", () => {
  it("returns every role, most recent first, with a readable period", () => {
    expect(tools.call("get_experience", {})).toEqual({
      roles: [
        {
          company: "Engine Co",
          role: "Analyst",
          place: "London",
          period: "1842 — now",
          current: true,
          description: "Builds engines.",
          highlights: ["Wrote the first program."],
          stack: ["Punch cards"],
        },
        {
          company: "Royal Society",
          role: "Translator",
          place: "London",
          period: "1840 — 1842",
          current: false,
          highlights: ["Translated Menabrea."],
          stack: ["French"],
        },
      ],
    });
  });

  it("filters by company, case-insensitively and by partial name", () => {
    const result = tools.call("get_experience", { company: "royal" });
    expect(result.roles.map((r) => r.company)).toEqual(["Royal Society"]);
  });

  it("returns no roles for a company that isn't in the CV", () => {
    expect(tools.call("get_experience", { company: "Acme" })).toEqual({
      roles: [],
    });
  });

  it("rejects a non-string company", () => {
    expect(() => tools.call("get_experience", { company: 42 })).toThrow();
  });
});

describe("get_projects", () => {
  it("returns every agent project without page-only links", () => {
    expect(tools.call("get_projects", {})).toEqual({
      projects: [
        {
          name: "Engine Agent",
          status: "personal-project",
          context: "Personal project",
          description: "Computes Bernoulli numbers.",
          stack: ["Punch cards"],
          links: [{ label: "source", url: "https://example.com/engine" }],
        },
        {
          name: "Loom Agent",
          status: "offline-evals",
          context: "Side business",
          description: "Weaves patterns.",
          result: "Offline evals: wrong patterns fell from 40% to 5%.",
          resultDetail: "Mean of 3 runs.",
          stack: ["Jacquard"],
        },
      ],
      // How he runs agents (#43), with only the links that work off the page.
      practices: [
        {
          title: "Tables checked twice",
          text: "Every table is recomputed by hand.",
          sources: [{ label: "the notes", url: "https://example.com/notes" }],
        },
        {
          title: "A human turns the crank",
          text: "The engine proposes, the operator decides.",
        },
      ],
    });
  });

  it("filters by status, still saying how he runs agents", () => {
    const result = tools.call("get_projects", { status: "offline-evals" });
    expect(result.projects.map((p) => p.name)).toEqual(["Loom Agent"]);
    expect(result.practices.map((p) => p.title)).toEqual([
      "Tables checked twice",
      "A human turns the crank",
    ]);
  });

  it("says in its description that it covers how he runs agents", () => {
    const tool = tools.list().find((t) => t.name === "get_projects")!;
    expect(tool.description).toMatch(/how he (?:builds and )?runs (?:them|agents)/);
  });

  it("lists every status in its description", () => {
    const tool = tools.list().find((t) => t.name === "get_projects")!;
    for (const label of ["in progress", "offline evals", "coming soon", "personal project"]) {
      expect(tool.description).toContain(label);
    }
  });

  it("rejects an unknown status", () => {
    expect(() => tools.call("get_projects", { status: "abandoned" })).toThrow();
  });
});

describe("get_stack", () => {
  it("returns every skill group", () => {
    expect(tools.call("get_stack", {})).toEqual({
      groups: [
        { key: "math", label: "Mathematics", items: ["Calculus", "Analysis"] },
        { key: "machines", label: "Machines", items: ["Difference engine"] },
      ],
    });
  });

  it("returns one group by key", () => {
    expect(tools.call("get_stack", { group: "machines" })).toEqual({
      groups: [
        { key: "machines", label: "Machines", items: ["Difference engine"] },
      ],
    });
  });

  it("rejects a group key that doesn't exist", () => {
    expect(() => tools.call("get_stack", { group: "cooking" })).toThrow();
  });
});

describe("get_contact", () => {
  it("returns the public contact channels", () => {
    expect(tools.call("get_contact", {})).toEqual({
      name: "Ada Lovelace",
      note: "Write to me.",
      email: "ada@example.com",
      github: "https://github.com/ada",
      linkedin: "https://www.linkedin.com/in/ada/",
      location: "London",
    });
  });

  // Local development: CONTACT_EMAIL unset, so no address to give (#51).
  describe("without a contact email", () => {
    const noEmail = createToolset({ ...fixture, contactEmail: undefined });
    const contact = () => noEmail.list().find((t) => t.name === "get_contact")!;

    it("returns GitHub and LinkedIn only, and says to message him on LinkedIn", () => {
      const output = noEmail.call("get_contact", {});
      expect(output).toEqual({
        name: "Ada Lovelace",
        note: "No email address is available here: message Ada Lovelace on LinkedIn.",
        github: "https://github.com/ada",
        linkedin: "https://www.linkedin.com/in/ada/",
        location: "London",
      });
      expect(contact().outputSchema.safeParse(output).success).toBe(true);
    });

    it("leaves email out of its description", () => {
      expect(contact().description).not.toMatch(/\bemail,/);
      expect(contact().description).toMatch(/no email address/i);
      expect(contact().description).toMatch(/LinkedIn/);
    });
  });
});

describe("the chat privacy note", () => {
  // Site-only copy (#46): the model's request must not change because of it,
  // so the recorded evals stay valid.
  it("is in no tool description, tool result or the system prompt", () => {
    const toolset = createToolset();
    const request = JSON.stringify({
      systemPrompt,
      tools: toolset.list().map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        input: z.toJSONSchema(tool.inputSchema),
        output: z.toJSONSchema(tool.outputSchema),
        result: toolset.call(tool.name, {}),
      })),
    });

    for (const fragment of [chatPrivacyNote, "Conversations aren't stored", "rate-limit counters"]) {
      expect(request).not.toContain(fragment);
    }
  });
});
