// Updates the colour tokens in the artifact's tokens.json from globals.css,
// keeping names, order and usage notes. Prints what changed; a colour that
// globals.css adds or drops is reported, not written, because it needs a
// usage note (added) or the user's go-ahead (removed).
//
// Usage: node sync-tokens.mjs <project dir>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const project = process.argv[2];
if (!project) throw new Error("usage: node sync-tokens.mjs <project dir>");
const css = readFileSync(join(repo, "src/app/globals.css"), "utf8");

// Each theme's block: `:root, [data-theme="night"] { … }` and `[data-theme="light"] { … }`.
// (The selector also appears in `@custom-variant light`, followed by a comma.)
const block = (selector) => {
  const escaped = selector.replace(/[[\]"]/g, "\\$&");
  const body = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (body === undefined) throw new Error(`globals.css has no ${selector} block`);
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, v]) => [name, v.replace(/\/\*.*?\*\//g, "").trim()]),
  );
};
const fromCss = { night: block('[data-theme="night"]'), light: block('[data-theme="light"]') };

// The artifact stores rgb() with commas; globals.css may use the space syntax.
const normalise = (v) =>
  v.toLowerCase().replace(/^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/, (_, r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${a})`);

const path = join(project, "tokens.json");
const tokens = JSON.parse(readFileSync(path, "utf8"));
const changed = [];
for (const token of tokens.color.tokens) {
  for (const theme of Object.keys(fromCss)) {
    const next = fromCss[theme][token.name];
    if (next === undefined) continue;
    const value = normalise(next);
    if (token.value[theme] !== value) {
      changed.push(`${token.name} (${theme}): ${token.value[theme]} → ${value}`);
      token.value[theme] = value;
    }
  }
}
const known = new Set(tokens.color.tokens.map((t) => t.name));
const inCss = new Set([...Object.keys(fromCss.night), ...Object.keys(fromCss.light)]);
const added = [...inCss].filter((n) => !known.has(n));
const removed = [...known].filter((n) => !inCss.has(n));
writeFileSync(path, JSON.stringify(tokens, null, 2) + "\n");
console.log(changed.length ? `changed:\n  ${changed.join("\n  ")}` : "no colour changed");
if (added.length) console.log(`in globals.css, not in tokens.json (add with a usage note): ${added.join(", ")}`);
if (removed.length) console.log(`in tokens.json, gone from globals.css (ask before removing): ${removed.join(", ")}`);
