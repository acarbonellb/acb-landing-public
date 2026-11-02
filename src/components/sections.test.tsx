import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AgentProject,
  Education as EducationEntry,
  Profile,
  Role,
  SkillGroup,
  SpokenLanguage,
} from "@/content/profile";
import {
  About,
  Agent,
  Contact,
  Education,
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
    status: "live",
    context: "Personal project",
    description: "Answers questions about the notes.",
    stack: ["Ink"],
    href: "#agent",
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

const education: EducationEntry[] = [
  {
    title: "Private tutoring in mathematics",
    school: "Home",
    place: "London",
    period: { from: 1820, to: 1833 },
  },
];

const languages: SpokenLanguage[] = [
  { name: "English", level: "Native" },
  { name: "French", level: "Fluent" },
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
    expect(notes.getByRole("link")).toHaveAttribute("href", "#agent");
  });
});

describe("Education", () => {
  it("shows education entries and spoken languages", () => {
    render(<Education education={education} languages={languages} />);

    expect(
      screen.getByRole("heading", { name: /education/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Private tutoring in mathematics"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Home · London · 1820 — 1833"),
    ).toBeInTheDocument();
    expect(screen.getByText("English")).toBeInTheDocument();
    expect(screen.getByText("Native")).toBeInTheDocument();
    expect(screen.getByText("French")).toBeInTheDocument();
    expect(screen.getByText("Fluent")).toBeInTheDocument();
  });
});

describe("Agent", () => {
  it("has the ask-my-agent section heading", () => {
    render(<Agent />);

    expect(
      screen.getByRole("heading", { name: /ask my agent/ }),
    ).toBeInTheDocument();
  });

  it("holds the chat, pointed at the local agent by default", () => {
    render(<Agent />);

    expect(
      screen.getByRole("textbox", { name: /ask the agent/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("http://localhost:8080/mcp")).toBeInTheDocument();
  });
});

describe("Contact", () => {
  it("shows the contact note and links to the email", () => {
    render(<Contact profile={profile} />);

    expect(screen.getByText("Say hi.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "ada@example.com" }),
    ).toHaveAttribute("href", "mailto:ada@example.com");
  });
});
