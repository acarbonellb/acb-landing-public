import { describe, expect, it } from "vitest";
import { section, sections } from "./sections";

describe("section registry", () => {
  it("lists the page's sections in order", () => {
    expect(sections.map((s) => s.id)).toEqual([
      "about",
      "stack",
      "experience",
      "projects",
      "agent",
      "contact",
    ]);
  });

  it("numbers each section by its position, in two digits", () => {
    expect(sections.map((s) => s.number)).toEqual(["01", "02", "03", "04", "05", "06"]);
    expect(section("agent").number).toBe("05");
  });

  it("gives the agents section the same nav label and title", () => {
    const projects = section("projects");
    expect(projects.nav).toBe(projects.title);
  });
});
