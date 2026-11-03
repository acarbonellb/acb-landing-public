import { describe, expect, it } from "vitest";
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
      email: "ada@example.com",
      github: "https://github.com/ada",
      linkedin: "https://www.linkedin.com/in/ada/",
    },
  },
  agents: [
    {
      slug: "engine",
      name: "Engine Agent",
      status: "personal-project",
      context: "Personal project",
      description: "Computes Bernoulli numbers.",
      stack: ["Punch cards"],
      href: "#agent",
    },
    {
      slug: "loom",
      name: "Loom Agent",
      status: "in-progress",
      context: "Side business",
      description: "Weaves patterns.",
      stack: ["Jacquard"],
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
        },
        {
          name: "Loom Agent",
          status: "in-progress",
          context: "Side business",
          description: "Weaves patterns.",
          stack: ["Jacquard"],
        },
      ],
    });
  });

  it("filters by status", () => {
    const result = tools.call("get_projects", { status: "in-progress" });
    expect(result.projects.map((p) => p.name)).toEqual(["Loom Agent"]);
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
});
