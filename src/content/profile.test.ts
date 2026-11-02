import { describe, expect, it } from "vitest";
import * as content from "./profile";
import {
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
      email: "alberto.carbonell.beceiro@gmail.com",
      github: "https://github.com/acarbonellb",
      linkedin: "https://www.linkedin.com/in/albertocarbonell/",
    });
  });

  it("lists the three agents, with the fraud agent in progress", () => {
    expect(agents.map((a) => [a.name, a.status])).toEqual([
      ["Fraud Detection Agent", "in-progress"],
      ["Organizer Support Agent", "live"],
      ["Portfolio Agent", "live"],
    ]);
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
