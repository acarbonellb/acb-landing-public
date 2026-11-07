// The artifact's component cards: one preview.html per component, rendering
// the real component from window.Acb with the site's real data (Acb.data).
// build.mjs calls writePreviews; a new component needs a card here and a
// README.md written into the artifact.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const main = (inner) => `h("main", { className: "mx-auto max-w-5xl px-4 sm:px-6" }, ${inner})`;
const pad = (inner) => `h("div", { className: "p-6" }, ${inner})`;

// name: [group, height, width|null, subtitle, render expression (A = window.Acb, D = A.data)]
const cards = {
  Window: ["Primitives", 220, 720, "Title bar with traffic lights, retro-shadow",
    pad(`h(A.Window, { title: "zsh — ls", className: "max-w-2xl" },
      h("p", { className: "text-sm" }, h("span", { className: "text-green" }, "~ "), "ls sections/"),
      h("p", { className: "mt-2 text-sm text-fg-dark" }, D.sections.map(function (s) { return s.id + "/"; }).join("  ")))`)],
  Section: ["Primitives", 200, 1024, "Numbered title from the section registry",
    main(`h(A.Section, { id: "about" }, h("p", { className: "max-w-3xl font-sans text-lg leading-relaxed" }, D.profile.summary[0]))`)],
  Tag: ["Primitives", 64, null, "Stack items on cards",
    pad(`h("div", { className: "flex flex-wrap gap-2" }, D.agentProjects[0].stack.map(function (s) { return h(A.Tag, { key: s }, s); }))`)],
  TerminalButton: ["Primitives", 72, null, "Resting, disabled",
    pad(`h("div", { className: "flex flex-wrap gap-3" },
      h(A.TerminalButton, { className: "px-2 py-0.5 text-fg-dark" }, "copy"),
      h(A.TerminalButton, { className: "px-2 py-0.5 text-fg-dark" }, "send ↵"),
      h(A.TerminalButton, { className: "px-2 py-0.5 text-fg-dark disabled:opacity-50", disabled: true }, "send ↵"))`)],
  Header: ["Chrome", 72, 1024, "tmux-style bar: handle, section tabs, theme toggle", `h(A.Header)`],
  StatusLine: ["Chrome", 56, 1024, "vim/lualine footer", `h(A.StatusLine)`],
  ThemeToggle: ["Chrome", 64, null, "Switches Tokyo Night / Tokyo Light", pad(`h(A.ThemeToggle)`)],
  MobileMenu: ["Chrome", 320, 400, "Below md: drop-down section list (click to open)",
    pad(`h("div", { className: "flex justify-end" }, h(A.MobileMenu, { items: D.sections.map(function (s) { return { href: "#" + s.id, label: s.nav }; }) }))`)],
  TypewriterTerminal: ["Terminal", 200, 720, "The hero's typed whoami output",
    pad(`h(A.Window, { title: "zsh — whoami", className: "max-w-2xl" }, h(A.TypewriterTerminal, { className: "text-sm leading-relaxed whitespace-pre-wrap", segments: D.heroTerminal }))`)],
  ChatTranscript: ["Terminal", 300, 720, "Example conversation (not a real answer)",
    pad(`h(A.ChatTranscript, { busy: false, turns: [{ id: 1, question: "What have you built with agents?",
      parts: [{ kind: "tool", id: "t1", label: "get_projects()" },
        { kind: "text", text: "Example answer, written for this preview. The live agent answers from the CV:\\n\\n" + D.agentProjects.map(function (p) { return "- **" + p.name + "**"; }).join("\\n") }],
      status: { kind: "answered", stopReason: "end_turn" } }] })`)],
  McpConnect: ["Terminal", 120, 720, "Copyable MCP command", pad(`h(A.McpConnect, { mcpUrl: D.endpoints.mcp })`)],
  Hero: ["Sections", 620, 1024, "Name, title, whoami terminal, calls to action", main(`h(A.Hero, { profile: D.profile })`)],
  About: ["Sections", 360, 1024, "", main(`h(A.About, { summary: D.profile.summary })`)],
  Stack: ["Sections", 420, 1024, "Skills as a TypeScript object", main(`h(A.Stack, { skillGroups: D.skillGroups })`)],
  Experience: ["Sections", 900, 1024, "Roles as a git log", main(`h(A.Experience, { roles: D.experience })`)],
  ExperienceEntry: ["Cards", 260, 1024, "One role; HEAD marks the current one",
    main(`h("div", { className: "py-6" }, h(A.ExperienceEntry, { role: D.experience[0], head: true }))`)],
  Projects: ["Sections", 900, 1024, "Agent cards and practices", main(`h(A.Projects, { agentProjects: D.agentProjects, practices: D.practices })`)],
  AgentCard: ["Cards", 360, 560, "Status badge, result, stack tags",
    pad(`h(A.AgentCard, { agent: D.agentProjects[0] })`)],
  Agent: ["Sections", 520, 1024, "Live chat window (requests cannot leave the artifact)", main(`h(A.Agent)`)],
  Contact: ["Sections", 320, 1024, "", main(`h(A.Contact)`)],
  Page: ["Page", 4000, 1280, "The whole home page, as src/app/page.tsx composes it", `h(A.Page)`],
};

/** Writes every card under <project dir>/components and returns how many. */
export function writePreviews(out) {
  for (const [name, [group, height, width, subtitle, render]] of Object.entries(cards)) {
    const marker = `<!-- @dsCard group="${group}" height=${height}${width ? ` width=${width}` : ""}${subtitle ? ` subtitle="${subtitle}"` : ""} -->`;
    const html = `${marker}
<!doctype html>
<html>
<head><meta charset="utf-8"><title>${name} — preview</title></head>
<body>
<div id="root"></div>
<script>
  var A = window.Acb, D = A.data, h = React.createElement;
  ReactDOM.createRoot(document.getElementById("root")).render(${render});
</script>
</body>
</html>
`;
    mkdirSync(join(out, "components", name), { recursive: true });
    writeFileSync(join(out, "components", name, "preview.html"), html);
  }
  return Object.keys(cards).length;
}
