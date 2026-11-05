import { render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentPractice,
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
    links: [
      { label: "source", href: "https://example.com/notes-agent" },
      { label: "eval report", href: "https://example.com/notes-agent/report.md" },
    ],
  },
  {
    slug: "loom-agent",
    name: "Loom Agent",
    context: "Built for a weaving mill",
    description: "Weaves patterns.",
    stack: ["Jacquard"],
  },
  {
    slug: "gear-agent",
    name: "Gear Agent",
    status: "offline-evals",
    context: "Built for a clockmaker",
    description: "Checks gear ratios.",
    result: "Offline evals: wrong ratios fell from 40% to 5%.",
    resultDetail: "Mean of 3 runs.",
    stack: ["Brass"],
  },
  {
    slug: "lace-agent",
    name: "Lace Agent",
    status: "coming-soon",
    context: "Built for a lace maker",
    description: "Will design lace.",
    stack: ["Bobbins"],
  },
];

const practices: AgentPractice[] = [
  {
    title: "Tables checked twice",
    text: "Every table is recomputed by hand before printing.",
    sources: [
      { label: "the notes", href: "https://example.com/notes" },
      { label: "the errata", href: "https://example.com/errata" },
    ],
  },
  {
    title: "A human turns the crank",
    text: "The engine proposes, the operator decides.",
    sources: [{ label: "Gear Agent", href: "#agent-gear-agent" }],
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
    render(<Projects agents={agents} practices={practices} />);

    expect(
      screen.getByRole("heading", { level: 2, name: /^04\.\s*agents I've built$/ }),
    ).toBeInTheDocument();
  });

  it("shows each agent with its context, description, status and stack", () => {
    render(<Projects agents={agents} practices={practices} />);

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
    expect(notes.getByRole("link", { name: "./Notes Agent" })).toHaveAttribute("href", "#agent");

    // No status claimed: no badge at all.
    const loom = within(screen.getByRole("article", { name: "./Loom Agent" }));
    expect(loom.getByText("Weaves patterns.")).toBeInTheDocument();
    expect(loom.queryByText(/in progress|personal project|live/)).not.toBeInTheDocument();
  });

  it("shows the offline-evals and coming-soon badges", () => {
    render(<Projects agents={agents} practices={practices} />);

    const gear = within(screen.getByRole("article", { name: "./Gear Agent" }));
    expect(gear.getByText("offline evals · deployment next")).toBeInTheDocument();
    const lace = within(screen.getByRole("article", { name: "./Lace Agent" }));
    expect(lace.getByText("coming soon")).toBeInTheDocument();
  });

  it("shows a measured result and its detail only on agents that have one", () => {
    render(<Projects agents={agents} practices={practices} />);

    const gear = within(screen.getByRole("article", { name: "./Gear Agent" }));
    expect(
      gear.getByText("Offline evals: wrong ratios fell from 40% to 5%."),
    ).toBeInTheDocument();
    expect(gear.getByText("Mean of 3 runs.")).toBeInTheDocument();

    const loom = within(screen.getByRole("article", { name: "./Loom Agent" }));
    expect(loom.queryByText(/offline evals|runs/i)).not.toBeInTheDocument();
  });

  it("links a card to its source and report, in a new tab, besides the card's own link", () => {
    render(<Projects agents={agents} practices={practices} />);

    const notes = within(screen.getByRole("article", { name: "./Notes Agent" }));
    const source = notes.getByRole("link", { name: /^source/ });
    expect(source).toHaveAttribute("href", "https://example.com/notes-agent");
    expect(source).toHaveAttribute("target", "_blank");
    expect(notes.getByRole("link", { name: /^eval report/ })).toHaveAttribute(
      "href",
      "https://example.com/notes-agent/report.md",
    );

    const gear = within(screen.getByRole("article", { name: "./Gear Agent" }));
    expect(gear.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says how the agents are run, each practice with its sources (#43)", () => {
    render(<Projects agents={agents} practices={practices} />);

    const block = within(
      screen.getByRole("region", { name: "how I run agents" }),
    );
    const items = block.getAllByRole("listitem");
    expect(items).toHaveLength(2);

    const checked = within(items[0]);
    expect(checked.getByText("Tables checked twice")).toBeInTheDocument();
    expect(
      checked.getByText("Every table is recomputed by hand before printing."),
    ).toBeInTheDocument();
    const notes = checked.getByRole("link", { name: /the notes/ });
    expect(notes).toHaveAttribute("href", "https://example.com/notes");
    expect(notes).toHaveAttribute("target", "_blank");
    expect(checked.getByRole("link", { name: /the errata/ })).toHaveAttribute(
      "href",
      "https://example.com/errata",
    );

    // A card on the page opens in place.
    const card = within(items[1]).getByRole("link", { name: "Gear Agent" });
    expect(card).toHaveAttribute("href", "#agent-gear-agent");
    expect(card).not.toHaveAttribute("target");
  });

  it("gives each agent card's heading the id its practice links point to", () => {
    render(<Projects agents={agents} practices={practices} />);

    expect(
      screen.getByRole("heading", { name: "./Gear Agent" }),
    ).toHaveAttribute("id", "agent-gear-agent");
  });
});

describe("Agent", () => {
  // The usage line fetches the agent's /stats: never the network in tests.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is section 05, ask my agent", () => {
    render(<Agent linkedin={profile.links.linkedin} />);

    expect(
      screen.getByRole("heading", { level: 2, name: /^05\.\s*ask my agent$/ }),
    ).toBeInTheDocument();
  });

  it("holds the chat, pointed at the local agent by default", () => {
    render(<Agent linkedin={profile.links.linkedin} />);

    expect(
      screen.getByRole("textbox", { name: /ask the agent/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("http://localhost:8080/mcp")).toBeInTheDocument();
  });

  it("says what happens to visitors' questions, right under the chat input", () => {
    render(<Agent linkedin={profile.links.linkedin} />);

    const note = screen.getByRole("note", { name: /privacy/i });
    expect(note).toHaveTextContent(/your questions go to claude \(anthropic\)/i);
    expect(note).toHaveTextContent(/conversations aren't stored/i);
    expect(note).toHaveTextContent(/30 days/);
    const form = screen.getByRole("textbox", { name: /ask the agent/i }).closest("form")!;
    expect(form.nextElementSibling).toBe(note);
  });

  it("shows no privacy note when there is no chat", () => {
    render(<Agent linkedin={profile.links.linkedin} endpoints={null} />);

    expect(screen.queryByRole("note", { name: /privacy/i })).not.toBeInTheDocument();
  });

  it("shows the agent's usage this week under the chat", async () => {
    const week = (answered: number) => ({
      week: "2026-W45",
      startsAt: "2026-11-02T00:00:00.000Z",
      chat: {
        requests: answered,
        answered,
        outcomes: {},
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.5,
        errorRate: 0,
        latency: { p50Ms: 3000, p95Ms: 5000 },
        firstText: { p50Ms: 1000, p95Ms: 2000 },
      },
      mcp: { requests: 0 },
    });
    const fetch = vi.fn(async () => Response.json({ current: week(7), previous: week(0) }));
    vi.stubGlobal("fetch", fetch);
    render(<Agent linkedin={profile.links.linkedin} />);

    expect(
      await screen.findByText("this week: 7 questions answered · p50 3 s · 0% errors · $0.50"),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("http://localhost:8080/stats", expect.anything());
  });

  it("says the agent is coming soon when none is configured, without a chat or MCP command", () => {
    render(<Agent linkedin={profile.links.linkedin} endpoints={null} />);

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

  it("shows the contact note and, until the chat is there, a LinkedIn link", () => {
    render(<Contact profile={profile} />);

    expect(screen.getByText("Say hi.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /linkedin/i })).toHaveAttribute(
      "href",
      profile.links.linkedin,
    );
  });

  it("never puts the address in the page (#50): the agent gives it out", () => {
    const html = renderToString(<Contact profile={profile} />);

    expect(html).not.toContain("@");
  });
});
