import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentStatuses } from "@/shared/profile";

// The build's output is the artifact's `project/` folder. These tests run it
// once on this checkout and read what it wrote.
const skill = __dirname;
let out: string;

beforeAll(() => {
  out = join(mkdtempSync(join(tmpdir(), "ds-build-")), "project");
  execFileSync("node", [join(skill, "scripts/build.mjs"), out], { encoding: "utf8", timeout: 240_000 });
}, 300_000);
afterAll(() => rmSync(resolve(out, ".."), { recursive: true, force: true }));

const read = (path: string) => readFileSync(join(out, path), "utf8");

// The components `window.Acb` exports, as the artifact lists them on
// 2026-11-27: a known list, not one read back from entry.tsx.
const components = [
  "Window", "Section", "Tag", "TerminalButton", "ExternalLink", "Header", "StatusLine",
  "ThemeToggle", "MobileMenu", "TypewriterTerminal", "ChatTranscript", "McpConnect",
  "Markdown", "Hero", "About", "Stack", "Experience", "ExperienceEntry", "Projects",
  "AgentCard", "Agent", "Contact", "CookieNotice", "Page",
];

describe("build.mjs writes the Design System's hand-written copy", () => {
  it.each(components)("writes components/%s/README.md", (name) => {
    expect(read(`components/${name}/README.md`)).toMatch(/Source: `src\//);
  });

  it("names in the AgentCard README every status the content allows, and no other", () => {
    const readme = read("components/AgentCard/README.md");
    expect(agentStatuses).toEqual(["in-progress", "deployed", "coming-soon", "personal-project"]);
    for (const status of agentStatuses) expect(readme).toContain(`\`${status}\``);
    expect(readme).not.toMatch(/offline/i);
  });

  it("writes the project README, the asset READMEs and the cover card", () => {
    expect(read("README.md")).toMatch(/^A personal portfolio dressed as a developer's terminal/);
    expect(read("assets/Brand/README.md")).toMatch(/^`icon\.svg` is the site icon/);
    expect(read("assets/Licenses/README.md")).toMatch(/^`OFL-VT323\.txt` is the SIL Open Font License/);
    expect(read("components/Cover/preview.html")).toMatch(/^<!-- @dsCard height=288 -->\n<!doctype html>/);
  });

  it("leaves no README of a component the bundle doesn't export", () => {
    const folders = readdirSync(join(out, "components"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !["lib", "Cover"].includes(e.name))
      .map((e) => e.name);
    expect(folders.sort()).toEqual([...components].sort());
  });

  it("lists every copied file in the `skill` part of sources.json, so a change to one triggers a sync", () => {
    const sources = JSON.parse(readFileSync(join(skill, "sources.json"), "utf8"));
    const listed = new Set(sources.skill);
    const prefix = ".claude/skills/design-system-sync/project/";
    for (const path of ["README.md", "assets/Brand/README.md", "assets/Licenses/README.md", "components/Cover/preview.html"])
      expect(listed).toContain(prefix + path);
    for (const name of components) expect(listed).toContain(`${prefix}components/${name}/README.md`);
  });
});
