// Generates the Design System's tokens.json: every value from the site's
// stylesheet (globals.css, compiled by the site's own Tailwind) and layout
// (layout.tsx's next/font families), every usage note and name from
// token-notes.json. Nothing in the output is written by hand.
//
// - color: the variables of globals.css's theme blocks; a note per variable.
// - shadow: the rules of globals.css that set box-shadow, by class name.
// - spacing `space-<n>`, radius `radius-<x>`: Tailwind's `p-<n>` and
//   `rounded-<x>`; container and type styles: the classes their note names.
// - type.families: `--font-<key>` in globals.css, through the next/font
//   loader that sets its variable in layout.tsx, or a font file in assets/;
//   the fallback stack after it comes from the note.
//
// A value that can't be parsed, a token with no note and a note with no token
// each fail with the token's name.
//
// Usage: node tokens.mjs [--repo <dir>] [--notes <file>] [--ref <ref>] [--synced <date>]
// Prints the tokens file. <dir> holds src/app/globals.css, src/app/layout.tsx
// and the font files (default: this repo); <file> defaults to token-notes.json.
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const thisRepo = join(here, "../../../..");
export const notesPath = join(here, "../token-notes.json");

const fail = (name, why) => {
  throw new Error(`token ${name}: ${why}`);
};

/**
 * The site's Tailwind (the one in this repo's node_modules) for `css`: a
 * function that compiles it afresh for each call, since a compiler keeps
 * every class it has built.
 */
async function tailwind(css) {
  const pnpmDir = join(thisRepo, "node_modules/.pnpm");
  const dir = readdirSync(pnpmDir).find((d) => d.startsWith("@tailwindcss+node@"));
  if (!dir) throw new Error("@tailwindcss/node is not installed: run `pnpm install --frozen-lockfile`");
  const require = createRequire(import.meta.url);
  const { compile } = require(join(pnpmDir, dir, "node_modules/@tailwindcss/node/dist/index.js"));
  return () => compile(css, { base: thisRepo, onDependency() {} });
}

/** The body of the block that opens at `open` (the index of its `{`). */
function blockAt(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return "";
}

const declarations = (body) =>
  [...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+|[a-z-]+)\s*:\s*([^;]+);/g)].map(([, p, v]) => [
    p,
    v.trim(),
  ]);

/** Resolves every `var()` in `value` from `vars`, or from the var's fallback. */
function resolveVars(value, vars, name) {
  let v = value;
  for (let guard = 0; v.includes("var(") && guard < 50; guard++) {
    // The last var() holds no other: resolve it, then the ones around it.
    const start = v.lastIndexOf("var(");
    let end = start + 4;
    for (let depth = 1; end < v.length && depth; end++) depth += v[end] === "(" ? 1 : v[end] === ")" ? -1 : 0;
    const [ref, ...fallback] = args(v.slice(start + 4, end - 1));
    const resolved = ref in vars ? vars[ref] : fallback.length ? fallback.join(", ") : fail(name, `${ref} is not defined`);
    v = v.slice(0, start) + resolved + v.slice(end);
  }
  if (v.includes("var(")) fail(name, `can't resolve ${value}`);
  return v;
}

/** Splits `s` at its top-level commas. */
function args(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...out, s.slice(start).trim()];
}

/** A resolved CSS length or number as `{ n, unit }`: rem becomes px. */
function quantity(expr, name) {
  const e = expr.trim();
  // Tailwind's rounded-full is an infinite length; a token needs a finite one,
  // and every engine clamps it to a huge value anyway.
  if (/^calc\(\s*infinity\s*\*\s*1px\s*\)$/.test(e)) return { n: 9999, unit: "px" };
  let m = /^(-?[\d.]+)(px|rem|em)?$/.exec(e);
  if (m) return m[2] === "rem" ? { n: +m[1] * 16, unit: "px" } : { n: +m[1], unit: m[2] ?? "" };
  m = /^clamp\((.*)\)$/.exec(e);
  // A fluid size is shown at its largest.
  if (m && args(m[1]).length === 3) return quantity(args(m[1])[2], name);
  m = /^calc\((.*)\)$/.exec(e);
  if (m) {
    const parts = /^(.+?)\s+([*/])\s+(.+)$/.exec(m[1].trim());
    if (parts) {
      const [a, b] = [quantity(parts[1], name), quantity(parts[3], name)];
      if (parts[2] === "*" && (!a.unit || !b.unit)) return { n: a.n * b.n, unit: a.unit || b.unit };
      if (parts[2] === "/" && (!b.unit || a.unit === b.unit)) return { n: a.n / b.n, unit: a.unit === b.unit ? "" : a.unit };
    }
  }
  fail(name, `can't parse the value ${expr}`);
}

const round = (n) => Math.round(n * 1e4) / 1e4;
const length = (q, name) => (q.unit === "px" ? `${round(q.n)}px` : fail(name, `expected a length, got ${q.n}${q.unit}`));

/** The CSS Tailwind writes for `classes`: its theme variables and the declarations, in order. */
async function utilities(compiler, classes) {
  const css = (await compiler()).build(classes.split(/\s+/).filter(Boolean));
  const theme = css.indexOf(":root, :host {");
  const vars = Object.fromEntries(theme < 0 ? [] : declarations(blockAt(css, css.indexOf("{", theme))));
  const layer = css.indexOf("@layer utilities {");
  const body = layer < 0 ? "" : blockAt(css, css.indexOf("{", layer));
  return { vars, decls: declarations(body.replace(/[^{}]*\{([^{}]*)\}/g, "$1")) };
}

async function generateValues(css, layout, repo, compiler, notes) {
  // Colour themes: `[data-theme="<id>"] { … }`, the first one also `:root`.
  const themeBlocks = [...css.matchAll(/\[data-theme="([\w-]+)"\]\s*\{/g)].map((m) => ({
    id: m[1],
    vars: Object.fromEntries(declarations(blockAt(css, m.index + m[0].length - 1))),
  }));
  const themes = themeBlocks.map((t) => t.id);
  for (const id of themes) if (!(id in notes.color.themes)) fail(id, "theme with no name in the notes");
  for (const id of Object.keys(notes.color.themes)) if (!themes.includes(id)) fail(id, "theme named in the notes is not in globals.css");

  const colourNames = [...new Set(themeBlocks.flatMap((t) => Object.keys(t.vars)).filter((p) => p.startsWith("--")))].map(
    (p) => p.slice(2),
  );
  check("color", colourNames, Object.keys(notes.color.tokens));
  const colour = (name, v) => {
    if (v === undefined) fail(name, "missing from a theme");
    const value = v.toLowerCase().replace(/^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/, "rgba($1, $2, $3, $4)");
    if (!/^#[0-9a-f]{3,8}$|^rgba?\([\d., ]+\)$/.test(value)) fail(name, `can't parse the colour ${v}`);
    return value;
  };
  const color = {
    themes: themes.map((id) => ({ id, name: notes.color.themes[id] })),
    tokens: colourNames.map((name) => ({
      name,
      value: Object.fromEntries(themeBlocks.map((t) => [t.id, colour(name, t.vars[`--${name}`])])),
      usage: notes.color.tokens[name],
    })),
  };

  // Shadows: plain rules of globals.css (`.retro-shadow { box-shadow: … }`).
  const shadowRules = [...css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)]
    .map(([, name, body]) => [name, Object.fromEntries(declarations(body))["box-shadow"]])
    .filter(([, v]) => v);
  check("shadow", shadowRules.map(([n]) => n), Object.keys(notes.shadow.tokens));
  const shadow = {
    tokens: shadowRules.map(([name, v]) => ({
      name,
      value: Object.fromEntries(themeBlocks.map((t) => [t.id, resolveVars(v, t.vars, name)])),
      usage: notes.shadow.tokens[name],
    })),
  };

  // One declaration of the CSS Tailwind writes for `classes`, resolved.
  const declared = async (name, classes, prop) => {
    const { vars, decls } = await utilities(compiler, classes);
    const found = decls.filter(([p]) => p === prop).at(-1);
    if (!found) fail(name, `\`${classes}\` sets no ${prop}`);
    return resolveVars(found[1], vars, name);
  };
  const scale = async (family, pattern, candidate, prop) => ({
    tokens: await Promise.all(
      Object.entries(notes[family].tokens).map(async ([name, usage]) => {
        const m = pattern.exec(name);
        if (!m) fail(name, `a ${family} token is named ${pattern.source}`);
        return { name, value: length(quantity(await declared(name, candidate(m[1]), prop), name), name), usage };
      }),
    ),
  });
  const spacing = await scale("spacing", /^space-([\d.]+)$/, (n) => `p-${n}`, "padding");
  const radius = await scale("radius", /^radius-([\w-]+)$/, (x) => `rounded-${x}`, "border-radius");
  const container = {
    note: notes.container.note,
    tokens: await Promise.all(
      Object.entries(notes.container.tokens).map(async ([name, { class: classes, usage }]) => ({
        name,
        value: length(quantity(await declared(name, classes ?? "", "max-width"), name), name),
        usage,
      })),
    ),
  };

  // Type styles: font size, line height, weight and tracking of their classes.
  const style = async ({ name, class: classes = "", sample, usage }) => {
    const { vars, decls } = await utilities(compiler, classes);
    const last = (prop) => decls.filter(([p]) => p === prop).at(-1)?.[1];
    const get = (prop) => (last(prop) === undefined ? undefined : resolveVars(last(prop), vars, name));
    if (get("font-size") === undefined) fail(name, `\`${classes}\` sets no font-size`);
    const fontSize = quantity(get("font-size"), name);
    // A text size's own line height is a ratio Tailwind sizes it by: shown in px.
    // One a leading-* class sets is shown as written.
    const lh = get("line-height") === undefined ? undefined : quantity(get("line-height"), name);
    if (!lh) fail(name, `\`${classes}\` sets no line-height`);
    const lineHeight = last("--tw-leading") !== undefined && !lh.unit ? lh.n : length(lh.unit ? lh : { n: lh.n * fontSize.n, unit: "px" }, name);
    const weight = get("font-weight") ?? "400";
    if (!/^\d+$/.test(weight)) fail(name, `can't parse the font weight ${weight}`);
    const tracking = get("letter-spacing");
    return {
      name,
      fontSize: length(fontSize, name),
      lineHeight,
      fontWeight: +weight,
      ...(tracking === undefined ? {} : { letterSpacing: tracking }),
      ...(sample === undefined ? {} : { sample }),
      usage,
    };
  };

  // Families: `--font-<key>: var(--font-x)` in @theme, and the next/font
  // loader in layout.tsx whose `variable` is `--font-x`; or a font file.
  const themeBlock = /@theme[^{]*\{/.exec(css);
  const themeVars = themeBlock ? Object.fromEntries(declarations(blockAt(css, themeBlock.index + themeBlock[0].length - 1))) : {};
  const loaders = Object.fromEntries(
    [...layout.matchAll(/=\s*(\w+)\(\{[^}]*variable:\s*"(--[\w-]+)"/g)].map(([, loader, variable]) => [
      variable,
      loader.replace(/_/g, " "),
    ]),
  );
  const siteFamilies = Object.keys(themeVars)
    .filter((p) => p.startsWith("--font-"))
    .map((p) => p.slice("--font-".length));
  const noted = notes.type.families;
  for (const key of siteFamilies) if (!(key in noted)) fail(key, "font family with no note");
  const fonts = [];
  const weights = { Thin: 100, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, Black: 900 };
  const quote = (f) => (/\s/.test(f) ? `"${f}"` : f);
  const families = Object.fromEntries(
    Object.entries(noted).map(([key, { file, fallback }]) => {
      let family;
      if (file) {
        if (!existsSync(join(repo, file))) fail(key, `${file} does not exist`);
        const m = /^(\w+)-(\w+?)(Italic)?\.(ttf|otf|woff2?)$/.exec(basename(file));
        if (!m || !(m[2] in weights)) fail(key, `can't parse the font file name ${basename(file)}`);
        family = m[1];
        fonts.push({ family, file: `fonts/${basename(file)}`, weight: String(weights[m[2]]), style: m[3] ? "italic" : "normal" });
      } else {
        if (!siteFamilies.includes(key)) fail(key, "font family noted but not in globals.css's @theme");
        const variable = /^var\((--[\w-]+)\)$/.exec(themeVars[`--font-${key}`])?.[1];
        family = loaders[variable];
        if (!family) fail(key, `no next/font loader in layout.tsx sets ${themeVars[`--font-${key}`]}`);
      }
      return [key, `${quote(family)}, ${fallback}`];
    }),
  );
  const type = {
    fonts,
    families,
    groups: await Promise.all(
      notes.type.groups.map(async (g) => {
        if (!(g.family in families)) fail(g.name, `type group of an unknown family ${g.family}`);
        return { name: g.name, family: g.family, styles: await Promise.all(g.styles.map(style)) };
      }),
    ),
  };
  return { color, type, spacing, radius, shadow, container };
}

/** Fails on a token with no note and on a note with no token. */
function check(family, tokens, noted) {
  for (const n of tokens) if (!noted.includes(n)) fail(n, `${family} token with no usage note`);
  for (const n of noted) if (!tokens.includes(n)) fail(n, `${family} usage note with no token`);
}

/**
 * The tokens file for the site in `repo`. `ref` and `synced` go into `meta`
 * as given, `components` as `meta.components`.
 */
export async function generateTokens({ repo = thisRepo, notes = notesPath, ref, synced, components } = {}) {
  const n = JSON.parse(readFileSync(notes, "utf8"));
  const css = readFileSync(join(repo, "src/app/globals.css"), "utf8");
  const layout = readFileSync(join(repo, "src/app/layout.tsx"), "utf8");
  const values = await generateValues(css, layout, repo, await tailwind(css), n);
  const { paths, data, ...meta } = n.meta;
  return {
    name: n.name,
    version: n.version,
    meta: { ...meta, ref, paths, components, data, synced },
    ...values,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = (f) => {
    const i = process.argv.indexOf(f);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  try {
    const tokens = await generateTokens({
      repo: flag("--repo"),
      notes: flag("--notes"),
      ref: flag("--ref"),
      synced: flag("--synced"),
    });
    process.stdout.write(JSON.stringify(tokens, null, 2) + "\n");
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
