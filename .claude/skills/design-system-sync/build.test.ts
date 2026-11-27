import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentStatuses } from "@/shared/profile";

// The build's output is the artifact's `project/` folder. These tests run it
// once on this checkout and read what it wrote.
const skill = __dirname;
const repoRoot = join(skill, "../../..");
let out: string;

beforeAll(() => {
  out = join(mkdtempSync(join(tmpdir(), "ds-build-")), "project");
  // As read from the artifact, with a source for a component that is gone.
  mkdirSync(out);
  writeFileSync(join(out, "tokens.json"), JSON.stringify({ meta: { components: { Gone: "src/gone.tsx" } } }));
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

describe("build.mjs generates tokens.json's meta.components from the bundle entry", () => {
  const sources = () => JSON.parse(read("tokens.json")).meta.components;

  it("has one entry per exported component, and none for one that is gone", () => {
    expect(Object.keys(sources()).sort()).toEqual([...components].sort());
  });

  it("names the file each component is written in", () => {
    expect(sources()).toMatchObject({
      Window: "src/components/ui.tsx",
      Section: "src/components/ui.tsx",
      Tag: "src/components/ui.tsx",
      TerminalButton: "src/components/ui.tsx",
      ExternalLink: "src/components/ui.tsx",
      Header: "src/components/header.tsx",
      StatusLine: "src/components/status-line.tsx",
      ThemeToggle: "src/components/theme-toggle.tsx",
      MobileMenu: "src/components/mobile-menu.tsx",
      TypewriterTerminal: "src/components/typewriter-terminal.tsx",
      ChatTranscript: "src/components/chat-transcript.tsx",
      McpConnect: "src/components/mcp-connect.tsx",
      Markdown: "src/components/markdown.tsx",
      Hero: "src/components/sections/hero.tsx",
      About: "src/components/sections/about.tsx",
      Stack: "src/components/sections/stack.tsx",
      Experience: "src/components/sections/experience.tsx",
      ExperienceEntry: "src/components/experience-entry.tsx",
      Projects: "src/components/sections/projects.tsx",
      AgentCard: "src/components/sections/agent-card.tsx",
      // Wrapped in entry.tsx with demo data: the source is what they wrap.
      Agent: "src/components/sections/agent.tsx",
      Contact: "src/components/sections/contact.tsx",
      CookieNotice: "src/components/cookie-notice.tsx",
    });
  });

  it("names only files that exist", () => {
    for (const file of Object.values<string>(sources())) expect(existsSync(join(repoRoot, file)), file).toBe(true);
  });
});

describe("build.mjs generates the component types file from the real TypeScript types", () => {
  const dts = () => read("components/index.d.ts");

  it("names exactly the statuses the content allows", () => {
    const union = /export type AgentStatus = ([^;]*);/.exec(dts())?.[1] ?? "";
    const typed = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(typed.sort()).toEqual([...agentStatuses].sort());
  });

  it("declares every exported component, and the data", () => {
    const declared = [...dts().matchAll(/export declare const (\w+)/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...components, "data"].sort());
  });

  it("writes the props a component really takes", () => {
    expect(dts()).toContain("export type AgentCardProps = { agent: AgentProject };");
    expect(dts()).toMatch(/export type AgentProject = \{[^}]*\n {2}status\?: AgentStatus;/);
  });

  it("type-checks on its own, against React's types", () => {
    const program = ts.createProgram([join(out, "components/index.d.ts")], {
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.dom.d.ts", "lib.esnext.d.ts"],
      typeRoots: [join(repoRoot, "node_modules/@types")],
      baseUrl: repoRoot,
      paths: { react: [join(repoRoot, "node_modules/@types/react")] },
    });
    const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(errors).toEqual([]);
  });
});
