import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentStatuses } from "@/shared/profile";

// The sync command, run twice on this checkout's HEAD. It builds in a
// temporary worktree of that commit and writes the artifact's `project/`
// folder and the sync manifest; these tests read what it wrote. Both go to a
// temporary manifest store (DS_SYNC_STORE), never the clone's real one, which
// the verification hook reads.
const skill = __dirname;
const repoRoot = join(skill, "../../..");
const sync = join(skill, "scripts/sync.mjs");
const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

type Entry = { path: string; file: string; contentType: string; sha256: string };
type Manifest = {
  commit: string;
  ref: string;
  artifact: string;
  root: string;
  files: Entry[];
  publish: { url: string; root: string; file_path: string; files: Record<string, { from: string; contentType: string }> };
};

const store = join(mkdtempSync(join(tmpdir(), "ds-store-")), "design-system-sync");
afterAll(() => rmSync(join(store, ".."), { recursive: true, force: true }));
const run = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync("node", [sync, ...args], {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, DS_SYNC_STORE: store, ...opts.env },
    encoding: "utf8",
    timeout: 600_000,
  });
const manifestOf = (stdout: string) => /^manifest: (.+)$/m.exec(stdout)?.[1] ?? "";
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const tempWorktrees = () =>
  git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ") && l.includes("/ds-sync-"));

let first: Manifest;
let second: Manifest;
let manifestPath: string;
let out: string;
let firstHashes: Record<string, string>;

beforeAll(() => {
  const a = run(["--ref", "HEAD"]);
  expect(a.status, a.stderr).toBe(0);
  manifestPath = manifestOf(a.stdout);
  first = JSON.parse(readFileSync(manifestPath, "utf8"));
  // The files as the first run wrote them, before the second replaces them.
  firstHashes = Object.fromEntries(first.files.map((e) => [e.path, sha256(e.file)]));
  const b = run(["--ref", "HEAD"]);
  expect(b.status, b.stderr).toBe(0);
  second = JSON.parse(readFileSync(manifestOf(b.stdout), "utf8"));
  out = join(second.root, "project");
}, 1_200_000);

const read = (path: string) => readFileSync(join(out, path), "utf8");

// The components `window.Acb` exports, as the artifact lists them on
// 2026-11-27: a known list, not one read back from entry.tsx.
const components = [
  "Window", "Section", "Tag", "TerminalButton", "ExternalLink", "Header", "StatusLine",
  "ThemeToggle", "MobileMenu", "TypewriterTerminal", "ChatTranscript", "McpConnect",
  "Markdown", "Hero", "About", "Stack", "Experience", "ExperienceEntry", "Projects",
  "AgentCard", "Agent", "Contact", "CookieNotice", "Page",
];
const noCard = ["ExternalLink", "Markdown"];

// Every file of the artifact's `project/` folder, as a `list` with
// `scope: "files"` showed it on 2026-11-27 (59 files). The icon is an asset
// upload, not a file, so it isn't here.
const projectFiles = [
  "project/README.md",
  "project/assets/Brand/README.md",
  "project/assets/Licenses/OFL-VT323.txt",
  "project/assets/Licenses/README.md",
  "project/components/Cover/preview.html",
  "project/components/bundle.css",
  "project/components/bundle.js",
  "project/components/index.d.ts",
  "project/components/lib/react-dom.production.min.js",
  "project/components/lib/react.production.min.js",
  "project/design-system.json",
  "project/fonts/VT323-Regular.ttf",
  "project/tokens.json",
  ...components.map((n) => `project/components/${n}/README.md`),
  ...components.filter((n) => !noCard.includes(n)).map((n) => `project/components/${n}/preview.html`),
];

describe("the sync command", () => {
  it("writes every file the artifact's project/ folder holds, and no other", () => {
    expect(first.files.map((e) => e.path).sort()).toEqual([...projectFiles].sort());
    const onDisk = readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `project/${relative(out, join(e.parentPath, e.name))}`);
    expect(onDisk.sort()).toEqual([...projectFiles].sort());
  });

  it("lists in the manifest each file's true sha256", () => {
    for (const e of second.files) expect(sha256(e.file), e.path).toBe(e.sha256);
  });

  it("gives the content type the artifact serves each file with, the types file as plain text", () => {
    const types = Object.fromEntries(first.files.map((e) => [e.path, e.contentType]));
    expect(types).toMatchObject({
      "project/README.md": "text/markdown",
      "project/assets/Licenses/OFL-VT323.txt": "text/plain",
      "project/components/Cover/preview.html": "text/html",
      "project/components/bundle.css": "text/css",
      "project/components/bundle.js": "text/javascript",
      "project/components/index.d.ts": "text/plain",
      "project/design-system.json": "application/json",
      "project/fonts/VT323-Regular.ttf": "font/ttf",
      "project/tokens.json": "application/json",
    });
  });

  it("gives identical hashes on a second run of the same commit", () => {
    expect(second.files.map((e) => [e.path, e.sha256])).toEqual(first.files.map((e) => [e.path, e.sha256]));
    expect(firstHashes).toEqual(Object.fromEntries(second.files.map((e) => [e.path, e.sha256])));
  });

  it("carries the publish call: the artifact URL, the index as the page and every file with its type", () => {
    const sources = JSON.parse(readFileSync(join(skill, "sources.json"), "utf8"));
    expect(first.artifact).toBe(sources.artifact);
    expect(first.publish.url).toBe(sources.artifact);
    expect(first.publish.file_path).toBe(join(first.publish.root, "project/design-system.json"));
    expect(Object.keys(first.publish.files).sort()).toEqual([...projectFiles].sort());
    expect(first.publish.files["project/components/index.d.ts"]).toEqual({
      from: "project/components/index.d.ts",
      contentType: "text/plain",
    });
  });

  it("copies the font and its licence from the repo", () => {
    expect(sha256(join(out, "fonts/VT323-Regular.ttf"))).toBe(sha256(join(repoRoot, "assets/VT323-Regular.ttf")));
    expect(read("assets/Licenses/OFL-VT323.txt")).toBe(readFileSync(join(repoRoot, "assets/OFL-VT323.txt"), "utf8"));
  });

  it("stamps tokens.json and the index with the commit it built and that commit's date", () => {
    const short = git("rev-parse", "--short=7", "HEAD");
    expect(first.commit).toBe(git("rev-parse", "HEAD"));
    expect(first.ref).toBe(`main@${short}`);
    const tokens = JSON.parse(read("tokens.json"));
    expect(tokens.meta.ref).toBe(`main@${short}`);
    expect(tokens.meta.synced).toBe(git("log", "-1", "--format=%cs", "HEAD"));
    const index = JSON.parse(read("design-system.json"));
    expect(index.lastChange.via).toBe(`GitHub · acarbonellb/acb-landing-public@${short}`);
    expect(index.lastChange.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(Date.parse(index.lastChange.at)).toBe(Date.parse(git("log", "-1", "--format=%cI", "HEAD")));
  });

  it("writes an index the artifact accepts, with the React the bundle was built for", () => {
    const index = JSON.parse(read("design-system.json"));
    const react = JSON.parse(readFileSync(join(repoRoot, "node_modules/react/package.json"), "utf8")).version;
    expect(index).toMatchObject({ v: 3, layout: "files", namespace: "Acb", title: "albertocarbonell.dev" });
    expect(index.createdOnFiles).toEqual({ v: 1, at: "2026-11-07T09:18:49Z" });
    expect(index.libraries).toEqual([
      { name: "react", version: react, global: "React", file: "components/lib/react.production.min.js" },
      { name: "react-dom", version: react, global: "ReactDOM", file: "components/lib/react-dom.production.min.js" },
    ]);
    expect(Object.keys(index.assetGroups.Brand.files)).toEqual(["icon.svg"]);
  });

  it("writes the manifest and the folder to the store it is given, keyed by commit", () => {
    expect(manifestPath).toBe(join(store, `${first.commit}.json`));
    expect(first.root).toBe(join(store, first.commit));
  });

  it("keeps the store under the git common directory by default, found from any worktree", () => {
    const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
    const real = join(common, "design-system-sync", `${first.commit}.json`);
    const here = run(["--manifest-path", "--ref", first.commit], { env: { DS_SYNC_STORE: "" } });
    expect(here.status, here.stderr).toBe(0);
    expect(here.stdout.trim()).toBe(real);
    const other = join(mkdtempSync(join(tmpdir(), "ds-other-")), "wt");
    git("worktree", "add", "--detach", "--no-checkout", other, "HEAD");
    try {
      const r = run(["--manifest-path", "--ref", first.commit], { cwd: other, env: { DS_SYNC_STORE: "" } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe(real);
    } finally {
      git("worktree", "remove", "--force", other);
      rmSync(join(other, ".."), { recursive: true, force: true });
    }
  });

  it("removes its temporary worktree", () => {
    expect(tempWorktrees()).toEqual([]);
  });

  it("fails with the reason, and removes its worktree, when a step times out", () => {
    const r = run(["--ref", "HEAD"], { env: { DS_SYNC_INSTALL_TIMEOUT_MS: "1" } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pnpm install.*timed out/);
    expect(tempWorktrees()).toEqual([]);
  }, 120_000);

  it("fails with the reason on a ref that doesn't exist", () => {
    const r = run(["--ref", "no-such-ref-for-the-sync"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no-such-ref-for-the-sync/);
  });
});

describe("the hand-written copy", () => {
  it.each(components)("writes components/%s/README.md from the skill's project/ folder", (name) => {
    expect(read(`components/${name}/README.md`)).toBe(
      readFileSync(join(skill, `project/components/${name}/README.md`), "utf8"),
    );
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

  it("lists every copied file in the `skill` part of sources.json, so a change to one triggers a sync", () => {
    const sources = JSON.parse(readFileSync(join(skill, "sources.json"), "utf8"));
    const listed = new Set(sources.skill);
    const prefix = ".claude/skills/design-system-sync/project/";
    for (const path of ["README.md", "assets/Brand/README.md", "assets/Licenses/README.md", "components/Cover/preview.html"])
      expect(listed).toContain(prefix + path);
    for (const name of components) expect(listed).toContain(`${prefix}components/${name}/README.md`);
  });
});

// Every component the bundle exports has its README, its type declaration and
// its source entry, with no leftovers.
describe("every exported component is complete", () => {
  const sources = () => JSON.parse(read("tokens.json")).meta.components;
  const dts = () => read("components/index.d.ts");

  it("has a README folder for each exported component, and none other", () => {
    const folders = readdirSync(join(out, "components"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !["lib", "Cover"].includes(e.name))
      .map((e) => e.name);
    expect(folders.sort()).toEqual([...components].sort());
  });

  it("declares every exported component in the types file, and the data", () => {
    const declared = [...dts().matchAll(/export declare const (\w+)/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...components, "data"].sort());
  });

  it("has one source entry per exported component, each the file it is written in", () => {
    expect(Object.keys(sources()).sort()).toEqual([...components].sort());
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
      // The component src/app/page.tsx renders, not a copy in entry.tsx.
      Page: "src/components/home-page.tsx",
    });
    for (const file of Object.values<string>(sources())) expect(existsSync(join(repoRoot, file)), file).toBe(true);
  });
});

describe("the component types file", () => {
  const dts = () => read("components/index.d.ts");

  it("names exactly the statuses the content allows", () => {
    const union = /export type AgentStatus = ([^;]*);/.exec(dts())?.[1] ?? "";
    const typed = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(typed.sort()).toEqual([...agentStatuses].sort());
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

// The render check (scripts/check.mjs) as a command: a project folder in, an
// exit code and the failures on stderr out. It needs Playwright's Chromium.
describe("the render check", () => {
  const check = join(skill, "scripts/check.mjs");
  const cards = components.filter((n) => !noCard.includes(n));
  const runCheck = (project: string) =>
    spawnSync("node", [check, project, mkdtempSync(join(tmpdir(), "ds-shots-"))], {
      encoding: "utf8",
      timeout: 600_000,
    });
  // A copy of the sync command's output, with `edit` applied to it.
  const copyWith = (edit: (project: string) => void) => {
    const copy = join(mkdtempSync(join(tmpdir(), "ds-broken-")), "project");
    cpSync(out, copy, { recursive: true });
    edit(copy);
    return copy;
  };
  // Replaces the render expression of a card's preview.
  const renderInCard = (project: string, name: string, render: string) => {
    const file = join(project, "components", name, "preview.html");
    const html = readFileSync(file, "utf8");
    const at = html.indexOf(".render(") + ".render(".length;
    const end = html.lastIndexOf(");\n</script>");
    writeFileSync(file, html.slice(0, at) + render + html.slice(end));
  };

  it("renders every card of the sync command's output in the night and the light theme", () => {
    const r = runCheck(out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${cards.length} previews render in night and light`);
  }, 600_000);

  // One run of the check for every failure it must name: each run starts a
  // browser and renders every card in both themes.
  it("fails on a card that throws, renders nothing or overflows, and on an exported component with no card, naming each", () => {
    const broken = copyWith((p) => {
      renderInCard(p, "Tag", `h(function Broken() { throw new Error("broken Tag card"); })`);
      renderInCard(p, "About", `null`);
      renderInCard(p, "Window", `h("div", { style: { width: "5000px" } }, "too wide")`);
      const bundle = join(p, "components/bundle.js");
      writeFileSync(bundle, readFileSync(bundle, "utf8") + "\nwindow.Acb.Gauge = function Gauge() { return null; };\n");
    });
    const r = runCheck(broken);
    expect(r.status).not.toBe(0);
    for (const theme of ["night", "light"]) {
      expect(r.stderr).toMatch(new RegExp(`^${theme} Tag: .*broken Tag card`, "m"));
      expect(r.stderr).toMatch(new RegExp(`^${theme} About: rendered nothing$`, "m"));
      expect(r.stderr).toMatch(new RegExp(`^${theme} Window: wider than its card$`, "m"));
    }
    expect(r.stderr).not.toMatch(/^\w+ (Header|Page):/m);
    expect(r.stderr).toMatch(/^Gauge: exported by the bundle with no card \(components\/Gauge\/preview\.html\)$/m);
    expect(r.stderr).not.toMatch(/^(ExternalLink|Markdown):/m);
  }, 600_000);
});

describe("the sources list", () => {
  it("lists the files the type program reads for the component types", () => {
    const sources = JSON.parse(readFileSync(join(skill, "sources.json"), "utf8"));
    expect(sources.bundle).toContain("src/shared/stats-contract.ts");
  });
});
