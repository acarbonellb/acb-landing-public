// Renders every preview the way the artifact's frame does (tokens, bundle.css,
// the React scripts, the bundle, then the preview's body), in every theme,
// and fails on a runtime error, an empty render or a page wider than its card.
// First checks that every component `window.Acb` exports (entry.tsx) has its
// README.md, its `declare const` in index.d.ts and its source in tokens.json
// `meta.components`, and that nothing is left over for one that is gone.
//
// Usage: node check.mjs <project dir> <shots dir> [component names to screenshot...]
import { createRequire } from "node:module";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { componentNames } from "./components.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { chromium } = createRequire(join(repo, "package.json"))("@playwright/test");
const [project, shots, ...wanted] = process.argv.slice(2);
if (!project || !shots) throw new Error("usage: node check.mjs <project dir> <shots dir> [names...]");
mkdirSync(shots, { recursive: true });

// A stand-in for the tokens.css the artifact compiles from tokens.json.
const t = JSON.parse(readFileSync(join(project, "tokens.json"), "utf8"));
const themes = t.color.themes.map((x) => x.id);
const value = (v, theme) => (typeof v === "string" ? v : (v[theme] ?? v[themes[0]]));
const colours = (theme) =>
  [...t.color.tokens, ...(t.shadow?.tokens ?? [])].map((k) => `--${k.name}: ${value(k.value, theme)};`).join("");
const lengths = ["spacing", "radius", "container"]
  .flatMap((f) => t[f]?.tokens ?? [])
  .map((k) => `--${k.name.replace(".", "\\.")}: ${k.value};`)
  .join("");
const families = Object.entries(t.type.families).map(([k, v]) => `--font-${k}: ${v};`).join("");
const tokensCss =
  `:root, [data-theme="${themes[0]}"] {${colours(themes[0])}} ` +
  themes.slice(1).map((th) => `[data-theme="${th}"] {${colours(th)}}`).join(" ") +
  ` :root {${lengths}${families}}`;
const comp = join(project, "components");

// Every component in step across the artifact's files (a card is optional:
// ExternalLink and Markdown have none).
const exported = componentNames();
const declared = [...readFileSync(join(comp, "index.d.ts"), "utf8").matchAll(/export declare const (\w+)/g)]
  .map((m) => m[1])
  .filter((n) => n !== "data");
const sourced = Object.keys(t.meta?.components ?? {});
const folders = readdirSync(comp, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "lib" && e.name !== "Cover")
  .map((e) => e.name);
const incomplete = [
  ...exported.flatMap((n) => [
    ...(existsSync(join(comp, n, "README.md")) ? [] : [`${n}: no components/${n}/README.md`]),
    ...(declared.includes(n) ? [] : [`${n}: no \`export declare const ${n}\` in components/index.d.ts`]),
    ...(sourced.includes(n) ? [] : [`${n}: no tokens.json meta.components.${n}`]),
  ]),
  ...[...new Set([...declared, ...sourced, ...folders])]
    .filter((n) => !exported.includes(n))
    .map((n) => `${n}: not in entry.tsx \`components\` but still in the artifact's files`),
];
if (incomplete.length) {
  console.error(`components out of step (see the skill's step 4):\n  ${incomplete.join("\n  ")}`);
  process.exit(1);
}

const head = (theme) => `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<style>${tokensCss}</style><link rel="stylesheet" href="file://${comp}/bundle.css">
<script src="file://${comp}/lib/react.production.min.js"></script>
<script src="file://${comp}/lib/react-dom.production.min.js"></script>
<script src="file://${comp}/bundle.js"></script></head>`;

// Requests the artifact cannot make anyway (the agent, Google Fonts offline).
const expected = /Failed to load resource|agent\.invalid|fonts\.g/;
const animated = new Set(["TypewriterTerminal", "Hero", "Page"]);
const names = readdirSync(comp).filter((n) => n !== "Cover" && existsSync(join(comp, n, "preview.html")));
const browser = await chromium.launch();
const failures = [];
for (const theme of themes) {
  for (const name of names) {
    const src = readFileSync(join(comp, name, "preview.html"), "utf8");
    const width = Number(/width=(\d+)/.exec(src.split("\n")[0])?.[1] ?? 800);
    const file = join(shots, `${name}.${theme}.html`);
    writeFileSync(file, head(theme) + src.slice(src.indexOf("<body>")));
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (c) => c.type() === "error" && !expected.test(c.text()) && errors.push(c.text()));
    await page.goto("file://" + file);
    await page.waitForTimeout(animated.has(name) ? 6000 : 500);
    const empty = await page.evaluate(() => !document.getElementById("root")?.innerHTML);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    const problems = [...errors, ...(empty ? ["rendered nothing"] : []), ...(wide ? ["wider than its card"] : [])];
    if (problems.length) failures.push(`${theme} ${name}: ${problems.join(" | ")}`);
    if (wanted.includes(name)) await page.screenshot({ path: join(shots, `${name}.${theme}.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`${exported.length} components complete; ${names.length} previews render in ${themes.join(" and ")}`);
