// Builds the Design System artifact's components from this checkout: React 19
// as two classic scripts, the site's components as one IIFE (`window.Acb`,
// running on the page's React, 19 or a Design canvas's 18),
// the previews, and the stylesheet compiled by the site's own Tailwind.
//
// Usage: node build.mjs <project dir> [--update-sources]
// <project dir> is the artifact's `project/` folder on disk (outside the
// repo). Writes only under <project dir>/components. Fails when the bundle
// reads a repo file that sources.json doesn't list, so the hook's watch list
// can't drift; --update-sources rewrites the bundle list instead.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { writePreviews } from "./previews.mjs";

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
mkdirSync(libDir, { recursive: true });

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
const entry = join(here, "entry.tsx");
const names = readFileSync(entry, "utf8")
  .match(/const components = \{([\s\S]*?)\};/)[1]
  .split(",")
  .map((s) => s.trim().split(":")[0].trim())
  .filter(Boolean);
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
    __EVAL_SUMMARY__: JSON.stringify(readFileSync(join(repo, evalSummary), "utf8")),
  },
  banner: { js: header },
  outfile: join(compDir, "bundle.js"),
});

// The repo files the bundle read, checked against the watch list.
const inputs = [
  ...Object.keys(result.metafile.inputs)
    .map((p) => relative(repo, join(process.cwd(), p)))
    .filter((p) => !p.includes(":") && !p.startsWith("node_modules/") && !p.startsWith("..") && !p.startsWith(".claude/")),
  evalSummary,
].sort();
// `content` files (copy and eval results) are inputs too, listed apart so the
// hook stays quiet about them.
const content = sources.content ?? [];
if (args.includes("--update-sources")) {
  sources.bundle = inputs.filter((p) => !content.includes(p));
  writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + "\n");
  console.log(`sources.json: bundle lists ${sources.bundle.length} files, content ${content.length}`);
} else {
  const missing = inputs.filter((p) => !sources.bundle.includes(p) && !content.includes(p));
  if (missing.length) {
    throw new Error(
      `the bundle reads files sources.json doesn't list:\n  ${missing.join("\n  ")}\n` +
        "rerun with --update-sources and commit sources.json",
    );
  }
  const stale = [...sources.bundle, ...content].filter((p) => !inputs.includes(p));
  if (stale.length) console.log(`sources.json lists files the bundle no longer reads: ${stale.join(", ")}`);
}

// 3. Previews first: Tailwind scans them for classes.
const previews = writePreviews(out);

// 4. The stylesheet: globals.css without its colour values (they live in
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
