import { describe, expect, it } from "vitest";
import * as content from "./profile";
import {
  agentPractices,
  agents,
  education,
  experience,
  languages,
  profile,
  skillGroups,
} from "./profile";

// Expected values are literals from the owner's CV (spec #2 / ticket #4).

describe("content module", () => {
  it("holds no lorem ipsum placeholder text", () => {
    expect(JSON.stringify(content)).not.toMatch(/lorem|ipsum|dolor sit/i);
  });

  it("describes Alberto with the CV title, location and links", () => {
    expect(profile.name).toBe("Alberto Carbonell");
    expect(profile.title).toBe(
      "Senior Software Engineer — AI Agents & Full-Stack TypeScript",
    );
    expect(profile.location).toBe("Spain · Remote");
    expect(profile.links).toEqual({
      github: "https://github.com/acarbonellb",
      linkedin: "https://www.linkedin.com/in/albertocarbonell/",
    });
  });

  it("lists the three agents, each with an accurate status", () => {
    expect(agents.map((a) => [a.name, a.status])).toEqual([
      ["Fraud Detection Agent", "offline-evals"],
      ["Organizer Support Agent", "coming-soon"],
      ["Portfolio Agent", "personal-project"],
    ]);
  });

  it("describes the fraud agent and its measured result with the approved copy", () => {
    const fraud = agents.find((a) => a.slug === "fraud-detection-agent");
    expect(fraud?.description).toBe(
      "Reviews newly published events and organizers on an event ticketing platform and leaves an approve / reject / request-info recommendation, with its reasons, for a human admin. Graded autonomy: it auto-approves only on evidence verified in code, and web sources can hold a decision back but never approve it.",
    );
    expect(fraud?.result).toBe(
      "Offline evals, 31 cases: on a local 9B model, approved fraud fell from 54% to 8% over twelve iterations, and fraud approved without a human from 27% to 0%. Claude Haiku 5.5, chosen for deployment: 86% accuracy vs 71%, 1% of fraud approved vs 8%.",
    );
    expect(fraud?.resultDetail).toBe(
      "Haiku escalates more cases to a human (86% vs 71%). About $0.002 per review. Haiku: mean of 3 runs; local model: 1 run.",
    );
  });

  it("names no ticketing platform and claims no ownership or order blocking", () => {
    const text = JSON.stringify(agents);
    expect(text).not.toMatch(/found(?:ed|er)|purchases|orders/i);
    expect(
      agents
        .filter((a) => a.slug !== "portfolio-agent")
        .map((a) => a.context),
    ).toEqual([
      "An online event ticketing platform",
      "An online event ticketing platform",
    ]);
  });

  it("says how Alberto runs agents, each practice backed by this public repo or the page (#43)", () => {
    const repo = "https://github.com/acarbonellb/acb-landing-public";
    expect(agentPractices).toEqual([
      {
        title: "Offline evals before shipping",
        text: "This site's agent records its eval cases against a real model and replays them in CI, with no model or network: a stale recording or an off-topic leak fails the build.",
        sources: [
          {
            label: "ADR 0001",
            href: `${repo}/blob/main/docs/adr/0001-agent-evals-record-replay.md`,
          },
        ],
      },
      {
        title: "Graded autonomy, a human in the loop",
        text: "The fraud detection agent recommends and a human admin decides; it approves on its own only on evidence verified in code.",
        sources: [{ label: "Fraud Detection Agent", href: "#agent-fraud-detection-agent" }],
      },
      {
        title: "Cost and limits tracked",
        text: "A token budget per request, per-IP rate limits and a monthly spend cap on this site's agent; every eval report shows mean tokens and latency per case.",
        sources: [
          { label: "guardrails", href: `${repo}#guardrails` },
          { label: "eval report", href: `${repo}/blob/main/agent/evals/report.md` },
        ],
      },
      {
        title: "Changes measured run over run",
        text: "Every eval run appends its metrics to a history, so a prompt, tool or content change that moves the numbers shows up next to the run before it.",
        sources: [
          { label: "eval history", href: `${repo}/blob/main/agent/evals/history.jsonl` },
        ],
      },
    ]);
  });

  it("links only to this repo or to a card on the page, never to another repo", () => {
    for (const { href } of agentPractices.flatMap((p) => p.sources)) {
      expect(href).toMatch(
        /^(?:https:\/\/github\.com\/acarbonellb\/acb-landing-public(?:[/#]|$)|#agent-)/,
      );
    }
  });

  it("lists the three roles, newest first", () => {
    expect(
      experience.map((job) => [job.company, job.role, job.period]),
    ).toEqual([
      ["CoverWallet", "Senior Software Engineer", { from: 2019, to: null }],
      ["M&GT Consulting", "Software Developer", { from: 2016, to: 2019 }],
      ["Indra", "Software Developer", { from: 2015, to: 2016 }],
    ]);
  });

  it("groups skills exactly as on the CV, without Go", () => {
    expect(skillGroups.map((g) => g.key)).toEqual([
      "ai",
      "languages",
      "backend",
      "infra",
      "frontend",
    ]);
    const all = skillGroups.flatMap((g) => g.items);
    expect(all).not.toContain("Go");
    expect(skillGroups.find((g) => g.key === "languages")?.items).toEqual([
      "TypeScript",
      "JavaScript",
      "Ruby",
    ]);
  });

  it("includes education and spoken languages", () => {
    expect(education).toHaveLength(1);
    expect(education[0].period).toEqual({ from: 2010, to: 2015 });
    expect(languages).toEqual([
      { name: "Spanish", level: "Native" },
      { name: "English", level: "C1" },
    ]);
  });
});
