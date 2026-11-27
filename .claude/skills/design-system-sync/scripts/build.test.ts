// The build's generated component types and source paths, read from its
// output for this checkout. Expected values come from the site's content and
// the repo's files, not from the TypeScript checker the build uses.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentStatuses } from "@/shared/profile";

const build = join(__dirname, "build.mjs");
const repoRoot = join(__dirname, "../../../..");
let project: string;
let dts: string;

beforeAll(() => {
  project = join(mkdtempSync(join(tmpdir(), "ds-build-")), "project");
  mkdirSync(project);
  writeFileSync(join(project, "tokens.json"), JSON.stringify({ meta: { components: { Gone: "src/gone.tsx" } } }));
  execFileSync("node", [build, project], { stdio: "pipe", timeout: 120_000 });
  dts = readFileSync(join(project, "components/index.d.ts"), "utf8");
}, 150_000);

afterAll(() => rmSync(join(project, ".."), { recursive: true, force: true }));

// The names `window.Acb` exports, as the bundle's header lists them.
const exported = () => {
  const header = readFileSync(join(project, "components/bundle.js"), "utf8").split("\n")[0];
  const json = /\/\* @ds-bundle: (.*) \*\//.exec(header)![1];
  return (JSON.parse(json).components as { name: string }[]).map((c) => c.name);
};

describe("the tokens file's meta.components", () => {
  const components = () => JSON.parse(readFileSync(join(project, "tokens.json"), "utf8")).meta.components;

  it("has one entry per exported component, and none for one that is gone", () => {
    expect(Object.keys(components()).sort()).toEqual(exported().sort());
  });

  it("names the file each component is written in", () => {
    expect(components()).toMatchObject({
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
    for (const file of Object.values<string>(components())) expect(existsSync(join(repoRoot, file)), file).toBe(true);
  });
});

describe("the component types file", () => {
  it("names exactly the statuses the content allows", () => {
    const union = /export type AgentStatus = ([^;]*);/.exec(dts)?.[1] ?? "";
    const typed = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(typed.sort()).toEqual([...agentStatuses].sort());
  });

  it("declares every exported component, and the data", () => {
    const declared = [...dts.matchAll(/export declare const (\w+)/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...exported(), "data"].sort());
  });

  it("type-checks on its own, against React's types", () => {
    const file = join(project, "components/index.d.ts");
    const program = ts.createProgram([file], {
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

  it("writes the props a component really takes", () => {
    expect(dts).toContain("export type AgentCardProps = { agent: AgentProject };");
    expect(dts).toMatch(/export type AgentProject = \{[^}]*\n {2}status\?: AgentStatus;/);
  });
});
