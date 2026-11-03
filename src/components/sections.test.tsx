import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AgentProject,
  Profile,
  Role,
  SkillGroup,
} from "@/content/profile";
import {
  About,
  Agent,
  Contact,
  Experience,
  Hero,
  Projects,
  Stack,
} from "./sections";

// Sections render the content they receive, so these tests pass small
// fixtures and assert on them: no dependency on the real CV text.

const profile: Profile = {
  name: "Ada Lovelace",
  handle: "ada",
  title: "Analyst — Engines & Notes",
  location: "London · Remote",
  tagline: "I write notes on engines.",
  summary: ["First about paragraph.", "Second about paragraph."],
  contactNote: "Say hi.",
  links: {
    email: "ada@example.com",
    github: "https://github.com/ada",
    linkedin: "https://www.linkedin.com/in/ada/",
  },
};

const agents: AgentProject[] = [
  {
    slug: "engine-agent",
    name: "Engine Agent",
    status: "in-progress",
    context: "Built for the Engine Society",
    description: "Computes Bernoulli numbers.",
    stack: ["Punch cards", "Gears"],
  },
  {
    slug: "notes-agent",
    name: "Notes Agent",
    status: "personal-project",
    context: "This notebook",
    description: "Answers questions about the notes.",
    stack: ["Ink"],
    href: "#agent",
  },
  {
    slug: "loom-agent",
    name: "Loom Agent",
    context: "Built for a weaving mill",
    description: "Weaves patterns.",
    stack: ["Jacquard"],
  },
];

const roles: Role[] = [
  {
    slug: "engines",
    hash: "abc1234",
    company: "Analytical Engines",
    role: "Lead Analyst",
    place: "London / Remote",
    period: { from: 1842, to: null },
    description: "Builds general-purpose engines.",
    highlights: ["Wrote the first program.", "Translated Menabrea."],
    stack: ["Gears", "Punch cards"],
  },
  {
    slug: "society",
    hash: "def5678",
    company: "Royal Society",
    role: "Correspondent",
    place: "London",
    period: { from: 1833, to: 1842 },
    highlights: ["Corresponded with Babbage."],
    stack: ["Letters"],
  },
];

const skillGroups: SkillGroup[] = [
  { key: "math", label: "Mathematics", items: ["Calculus", "Algebra"] },
  { key: "tools", label: "Tools", items: ["Quill"] },
];

describe("Hero", () => {
  it("shows the name as the page heading, title, location, tagline and links", () => {
    render(<Hero profile={profile} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Ada Lovelace" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Analyst — Engines & Notes")).toBeInTheDocument();
    expect(screen.getByText("London · Remote")).toBeInTheDocument();
    expect(screen.getByText("I write notes on engines.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /github/ })).toHaveAttribute(
      "href",
      "https://github.com/ada",
    );
    expect(screen.getByRole("link", { name: /linkedin/ })).toHaveAttribute(
      "href",
      "https://www.linkedin.com/in/ada/",
    );
  });
});

describe("About", () => {
  it("shows every summary paragraph", () => {
    render(<About summary={profile.summary} />);

    expect(screen.getByRole("heading", { name: /about/ })).toBeInTheDocument();
    expect(screen.getByText("First about paragraph.")).toBeInTheDocument();
    expect(screen.getByText("Second about paragraph.")).toBeInTheDocument();
  });
});

describe("Stack", () => {
  it("lists every skill group key and item", () => {
    render(<Stack skillGroups={skillGroups} />);

    for (const text of ["math", "tools"]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    for (const text of ['"Calculus"', '"Algebra"', '"Quill"']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});

describe("Experience", () => {
  it("shows each role with company, place, period, description and highlights", () => {
    render(<Experience roles={roles} />);

    expect(
      screen.getByRole("heading", { name: "Lead Analyst" }),
    ).toBeInTheDocument();
    expect(screen.getByText("@ Analytical Engines")).toBeInTheDocument();
    expect(
      screen.getByText("1842 — now · London / Remote"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Builds general-purpose engines."),
    ).toBeInTheDocument();
    expect(screen.getByText("Wrote the first program.")).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Correspondent" }),
    ).toBeInTheDocument();
    expect(screen.getByText("@ Royal Society")).toBeInTheDocument();
    expect(screen.getByText("1833 — 1842 · London")).toBeInTheDocument();
    expect(screen.getByText("Corresponded with Babbage.")).toBeInTheDocument();
  });

  it("marks only the first role as HEAD", () => {
    render(<Experience roles={roles} />);

    expect(screen.getAllByText("(HEAD -> main)")).toHaveLength(1);
  });
});

describe("Projects", () => {
  it("is section 04, agents I've built", () => {
    render(<Projects agents={agents} />);

    expect(
      screen.getByRole("heading", { level: 2, name: /^04\.\s*agents I've built$/ }),
    ).toBeInTheDocument();
  });

  it("shows each agent with its context, description, status and stack", () => {
    render(<Projects agents={agents} />);

    const engine = within(
      screen.getByRole("article", { name: "./Engine Agent" }),
    );
    expect(
      engine.getByText("Built for the Engine Society"),
    ).toBeInTheDocument();
    expect(engine.getByText("Computes Bernoulli numbers.")).toBeInTheDocument();
    expect(engine.getByText("in progress")).toBeInTheDocument();
    expect(engine.getByText("Punch cards")).toBeInTheDocument();
    expect(engine.queryByRole("link")).not.toBeInTheDocument();

    const notes = within(
      screen.getByRole("article", { name: "./Notes Agent" }),
    );
    expect(notes.queryByText("in progress")).not.toBeInTheDocument();
    expect(notes.getByText("personal project")).toBeInTheDocument();
    expect(notes.getByRole("link")).toHaveAttribute("href", "#agent");

    // No status claimed: no badge at all.
    const loom = within(screen.getByRole("article", { name: "./Loom Agent" }));
    expect(loom.getByText("Weaves patterns.")).toBeInTheDocument();
    expect(loom.queryByText(/in progress|personal project|live/)).not.toBeInTheDocument();
  });
});

describe("Agent", () => {
  it("is section 05, ask my agent", () => {
    render(<Agent />);

    expect(
      screen.getByRole("heading", { level: 2, name: /^05\.\s*ask my agent$/ }),
    ).toBeInTheDocument();
  });

  it("holds the chat, pointed at the local agent by default", () => {
    render(<Agent />);

    expect(
      screen.getByRole("textbox", { name: /ask the agent/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("http://localhost:8080/mcp")).toBeInTheDocument();
  });

  it("says the agent is coming soon when none is configured, without a chat or MCP command", () => {
    render(<Agent endpoints={null} />);

    expect(screen.getByText(/agent coming soon/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /ask the agent/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/claude mcp add/)).not.toBeInTheDocument();
    expect(screen.queryByText(/localhost/)).not.toBeInTheDocument();
  });
});

describe("Contact", () => {
  it("is section 06, contact", () => {
    render(<Contact profile={profile} />);

    expect(
      screen.getByRole("heading", { level: 2, name: /^06\.\s*contact$/ }),
    ).toBeInTheDocument();
  });

  it("shows the contact note and links to the email", () => {
    render(<Contact profile={profile} />);

    expect(screen.getByText("Say hi.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "ada@example.com" }),
    ).toHaveAttribute("href", "mailto:ada@example.com");
  });
});
