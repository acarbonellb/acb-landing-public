// Builds the Design System artifact's components from this checkout: React 19
// as two classic scripts, the site's components as one IIFE (`window.Acb`,
// running on the page's React, 19 or a Design canvas's 18),
// the previews, the stylesheet compiled by the site's own Tailwind, the
// component types (types.mjs) and tokens.json (tokens.mjs).
//
// Usage: node build.mjs <project dir> [--update-sources]
// The sync command (sync.mjs) runs it in a temporary worktree of the commit
// it syncs, so HEAD is that commit; run it by hand only to try a change.
// <project dir> is the artifact's whole `project/` folder, written outside
// the repo: the skill's `project/` folder (READMEs and the cover card),
// tokens.json, the index (design-system.json, from index.json), the fonts
// and their licence, and everything under components/.
// Fails when the bundle or the component types read a repo file that
// sources.json doesn't list, so the watch list can't drift; --update-sources
// rewrites the bundle list instead. Ends by listing every file the build
// added or changed against what the folder held before.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { writePreviews } from "./previews.mjs";
import { componentNames, entry, hashes } from "./components.mjs";
import { generateTokens } from "./tokens.mjs";
import { componentTypes } from "./types.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skill = dirname(here);
const repo = join(skill, "../../..");
const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--"));
if (!out) throw new Error("usage: node build.mjs <project dir> [--update-sources]");
if (!relative(repo, out).startsWith("..")) throw new Error("the project dir must be outside the repo");
if (!existsSync(join(repo, "node_modules"))) throw new Error("run `pnpm install --frozen-lockfile` first");

// Packages the site already installs (esbuild comes with Vite, the Tailwind
// compiler with @tailwindcss/turbopack), so the build adds no dependency.
const pnpmDir = join(repo, "node_modules/.pnpm");
const fromPnpm = (prefix, file) => {
  const dir = readdirSync(pnpmDir).find((d) => d.startsWith(prefix));
  if (!dir) throw new Error(`${prefix} is not installed`);
  return join(pnpmDir, dir, "node_modules", file);
};
const require = createRequire(import.meta.url);
const esbuild = require(fromPnpm("esbuild@", "esbuild"));
const { compile } = require(fromPnpm("@tailwindcss+node@", "@tailwindcss/node/dist/index.js"));
const { Scanner } = require(fromPnpm("@tailwindcss+oxide@", "@tailwindcss/oxide"));

const sourcesPath = join(skill, "sources.json");
const sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
const compDir = join(out, "components");
const libDir = join(compDir, "lib");
const before = hashes(out);
mkdirSync(libDir, { recursive: true });

// 0. The hand-written copy (READMEs, the cover card), kept in the skill's
// `project/` folder at the paths the artifact uses.
cpSync(join(skill, "project"), out, { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  nodePaths: [join(repo, "node_modules")],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
};
// Resolves bare imports to the globals the library scripts define.
const toGlobals = (map) => ({
  name: "globals",
  setup(b) {
    const filter = new RegExp(`^(${Object.keys(map).join("|")})$`);
    b.onResolve({ filter }, (a) => ({ path: a.path, namespace: "global" }));
    b.onLoad({ filter: /.*/, namespace: "global" }, (a) => ({
      contents: `module.exports = window.${map[a.path]};`,
      loader: "js",
    }));
  },
});
// The components resolve React to whichever React the page loaded, so the
// bundle also runs on a Design canvas, whose runtime provides React 18.
// `react/jsx-runtime` goes through `createElement` instead of React 19's own
// runtime, whose elements React 18 rejects (React's minified error 31), and
// `useEffectEvent`, which React 18 lacks, falls back to a ref.
const pageReact = {
  name: "page-react",
  setup(b) {
    b.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, (a) => ({ path: a.path, namespace: "page-react" }));
    b.onLoad({ filter: /^react$/, namespace: "page-react" }, () => ({
      contents: `var R = window.React;
module.exports = R.useEffectEvent ? R : Object.assign({}, R, {
  useEffectEvent: function (fn) {
    var ref = R.useRef(fn);
    R.useLayoutEffect(function () { ref.current = fn; });
    return R.useCallback(function () { return ref.current.apply(void 0, arguments); }, []);
  },
});`,
      loader: "js",
    }));
    b.onLoad({ filter: /^react\/jsx-runtime$/, namespace: "page-react" }, () => ({
      contents: `var R = window.React;
function jsx(type, props, key) {
  return R.createElement(type, key === undefined ? props : Object.assign({}, props, { key: key }));
}
module.exports = { Fragment: R.Fragment, jsx: jsx, jsxs: jsx };`,
      loader: "js",
    }));
  },
};
const alias = {
  name: "alias",
  setup(b) {
    b.onResolve({ filter: /^@\// }, (a) =>
      b.resolve("./" + a.path.slice(2), { resolveDir: join(repo, "src"), kind: a.kind }),
    );
  },
};

// 1. React 19 ships no UMD build, so it is bundled here as two classic scripts.
await esbuild.build({
  ...common,
  stdin: { contents: `window.React = require("react");`, resolveDir: repo },
  outfile: join(libDir, "react.production.min.js"),
});
await esbuild.build({
  ...common,
  plugins: [toGlobals({ react: "React" })],
  stdin: {
    contents: `window.ReactDOM = Object.assign({}, require("react-dom"), require("react-dom/client"));`,
    resolveDir: repo,
  },
  outfile: join(libDir, "react-dom.production.min.js"),
});

// 2. The components, as `window.Acb`.
const names = componentNames();
const header = `/* @ds-bundle: ${JSON.stringify({ format: 4, namespace: "Acb", components: names.map((name) => ({ name })) })} */\n`;
const evalSummary = "agent/evals/summary.json";
const result = await esbuild.build({
  ...common,
  entryPoints: [entry],
  jsx: "automatic",
  metafile: true,
  plugins: [pageReact, toGlobals({ "react-dom": "ReactDOM", "react-dom/client": "ReactDOM" }), alias],
  define: {
    ...common.define,
    "process.env.NEXT_PUBLIC_AGENT_URL": "undefined",
    // No site analytics in the artifact: nothing is reported from it. The
    // cookie notice's card turns the notice on by hand (entry.tsx).
    "process.env.NEXT_PUBLIC_POSTHOG_KEY": "undefined",
    __EVAL_SUMMARY__: JSON.stringify(readFileSync(join(repo, evalSummary), "utf8")),
  },
  banner: { js: header },
  outfile: join(compDir, "bundle.js"),
});

// 3. The component types and each component's source (tokens.json
// `meta.components`, step 6), from the TypeScript checker (types.mjs): no
// hand-written copy to go stale.
const types = componentTypes();
writeFileSync(join(compDir, "index.d.ts"), types.dts);

// The repo files the bundle and the types read, checked against the watch list.
const inputs = [
  ...new Set([
    ...Object.keys(result.metafile.inputs)
      .map((p) => relative(repo, join(process.cwd(), p)))
      .filter((p) => !p.includes(":") && !p.startsWith("node_modules/") && !p.startsWith("..") && !p.startsWith(".claude/")),
    ...types.inputs,
    evalSummary,
  ]),
].sort();
// `content` files (copy and eval results) are inputs too, kept in their own
// part of the list so they read as content, not code. Every part triggers a
// sync (pending.mjs), `content` included.
const content = sources.content ?? [];
if (args.includes("--update-sources")) {
  sources.bundle = inputs.filter((p) => !content.includes(p));
  writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + "\n");
  console.log(`sources.json: bundle lists ${sources.bundle.length} files, content ${content.length}`);
} else {
  const missing = inputs.filter((p) => !sources.bundle.includes(p) && !content.includes(p));
  if (missing.length) {
    throw new Error(
      `the bundle or the types read files sources.json doesn't list:\n  ${missing.join("\n  ")}\n` +
        "rerun with --update-sources and commit sources.json",
    );
  }
  const stale = [...sources.bundle, ...content].filter((p) => !inputs.includes(p));
  if (stale.length) console.log(`sources.json lists files the bundle no longer reads: ${stale.join(", ")}`);
}

// 4. Previews first: Tailwind scans them for classes.
const previews = writePreviews(out);

// 5. The stylesheet: globals.css without its colour values (they live in
// tokens.json, so an edit on the artifact's page wins), compiled by the
// site's Tailwind over the components and the previews.
const globalsCss = readFileSync(join(repo, "src/app/globals.css"), "utf8");
const start = globalsCss.indexOf("/* Tokyo Night (default) */");
const end = globalsCss.indexOf("@theme inline");
if (start < 0 || end < start) throw new Error("globals.css changed shape: the colour blocks were not found");
const input =
  globalsCss.slice(0, start) +
  globalsCss.slice(end) +
  `
/* Design System glue: next/font's variables point at the system's font
   tokens, and body gets what layout.tsx sets on it. */
:root {
  --font-geist-sans: var(--font-sans);
  --font-jetbrains-mono: var(--font-mono);
}
body {
  font-family: var(--font-jetbrains-mono);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background-image: radial-gradient(var(--border) 1px, transparent 1px);
  background-size: 24px 24px;
}
`;
const compiler = await compile(input, { base: repo, onDependency() {} });
const scanner = new Scanner({
  sources: [
    { base: join(repo, "src"), pattern: "**/*", negated: false },
    { base: compDir, pattern: "**/*.html", negated: false },
  ],
});
const fonts =
  '@import url("https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap");\n';
writeFileSync(join(compDir, "bundle.css"), fonts + compiler.build(scanner.scan()));

// Consumers inline these files, so none may close the element it sits in.
for (const f of ["bundle.js", "bundle.css", "lib/react.production.min.js", "lib/react-dom.production.min.js"]) {
  const bad = /<\/script|<!--|<\/style/i.exec(readFileSync(join(compDir, f), "utf8"));
  if (bad) throw new Error(`${f} contains ${bad[0]}`);
}
const react = JSON.parse(readFileSync(join(repo, "node_modules/react/package.json"), "utf8")).version;
console.log(`built ${names.length} components and ${previews} previews with React ${react}`);

// 6. tokens.json, for the checked-out commit: `meta.ref` and `meta.synced` are
// its short sha and its date, so two builds of one commit give the same file.
// `meta.components` comes from step 3.
const tokensPath = join(out, "tokens.json");
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const tokens = await generateTokens({
  ref: `main@${git("rev-parse", "--short=7", "HEAD")}`,
  synced: git("log", "-1", "--format=%cs", "HEAD"),
  components: types.sources,
});
writeFileSync(tokensPath, JSON.stringify(tokens, null, 2) + "\n");

// 7. The font files tokens.json names (`type.fonts[].file`), from the files
// token-notes.json gives them, and the font's licence.
const notes = JSON.parse(readFileSync(join(skill, "token-notes.json"), "utf8"));
const fontFiles = Object.values(notes.type.families)
  .map((f) => f.file)
  .filter(Boolean);
for (const font of tokens.type.fonts) {
  const from = fontFiles.find((f) => basename(f) === basename(font.file));
  if (!from) throw new Error(`tokens.json names ${font.file}, which no family in token-notes.json gives`);
  mkdirSync(join(out, "fonts"), { recursive: true });
  cpSync(join(repo, from), join(out, font.file));
}
mkdirSync(join(out, "assets/Licenses"), { recursive: true });
cpSync(join(repo, "assets/OFL-VT323.txt"), join(out, "assets/Licenses/OFL-VT323.txt"));

// 8. The index, design-system.json, from the skill's index.json: the
// libraries at the React the scripts were built from and `lastChange` from
// the commit, so it too depends only on the commit. An asset is an upload the
// index names by its blob id, so a changed asset file fails here: upload it
// and record its new blob, size and sha256 in index.json.
const indexSource = JSON.parse(readFileSync(join(skill, "index.json"), "utf8"));
for (const [path, { source, sha256 }] of Object.entries(indexSource.uploads)) {
  const actual = createHash("sha256").update(readFileSync(join(repo, source))).digest("hex");
  if (actual !== sha256) {
    throw new Error(
      `${source} changed: upload it to the artifact as ${path} and record its blob, size and sha256 in index.json`,
    );
  }
}
const short = git("rev-parse", "--short=7", "HEAD");
const index = {
  ...indexSource.index,
  libraries: indexSource.index.libraries.map(({ name, ...rest }) => ({
    name,
    version: JSON.parse(readFileSync(join(repo, "node_modules", name, "package.json"), "utf8")).version,
    ...rest,
  })),
  lastChange: {
    ...indexSource.index.lastChange,
    at: new Date(git("log", "-1", "--format=%cI", "HEAD")).toISOString().replace(/\.\d{3}Z$/, "Z"),
    via: `GitHub · ${notes.meta.repo}@${short}`,
    note: `Synced from main@${short}: ${git("log", "-1", "--format=%s", "HEAD")}`,
  },
};
writeFileSync(join(out, "design-system.json"), JSON.stringify(index, null, 2) + "\n");

// The build's share of the publish: what it added or changed.
const after = hashes(out);
const publish = Object.keys(after)
  .filter((f) => before[f] !== after[f])
  .sort()
  .map((f) => `project/${f}${f in before ? "" : " (new)"}`);
console.log(publish.length ? `publish:\n  ${publish.join("\n  ")}` : "publish: nothing (the build changed no file)");
