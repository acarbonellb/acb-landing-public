import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// tokens.mjs writes the Design System's tokens file from the stylesheet, the
// layout and the usage notes in token-notes.json.
const script = resolve(__dirname, "tokens.mjs");
const repo = resolve(__dirname, "../../../..");
const notesFile = resolve(__dirname, "../token-notes.json");

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(...args: string[]) {
  const r = spawnSync("node", [script, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A copy of the repo's token sources, with `edit` applied to their text. */
function site(edit: { css?: (s: string) => string; layout?: (s: string) => string; notes?: (n: Notes) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tokens-"));
  dirs.push(root);
  for (const path of ["src/app/globals.css", "src/app/layout.tsx", "assets/VT323-Regular.ttf"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(root, path));
  }
  const rewrite = (path: string, f?: (s: string) => string) =>
    f && writeFileSync(join(root, path), f(readFileSync(join(root, path), "utf8")));
  rewrite("src/app/globals.css", edit.css);
  rewrite("src/app/layout.tsx", edit.layout);
  const notes = JSON.parse(readFileSync(notesFile, "utf8"));
  edit.notes?.(notes);
  writeFileSync(join(root, "notes.json"), JSON.stringify(notes));
  return ["--repo", root, "--notes", join(root, "notes.json")];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Notes = any;

// Every value, without the usage notes, `meta` or the descriptive copy.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const values = (t: any) => ({
  themes: t.color.themes,
  color: t.color.tokens.map(({ name, value }: Notes) => ({ name, value })),
  fonts: t.type.fonts,
  families: t.type.families,
  type: t.type.groups.map((g: Notes) => ({
    name: g.name,
    family: g.family,
    styles: g.styles.map(({ name, fontSize, lineHeight, fontWeight, letterSpacing }: Notes) => ({
      name,
      fontSize,
      lineHeight,
      fontWeight,
      letterSpacing,
    })),
  })),
  ...Object.fromEntries(
    ["spacing", "radius", "shadow", "container"].map((k) => [
      k,
      t[k].tokens.map(({ name, value }: Notes) => ({ name, value })),
    ]),
  ),
});

describe("tokens.mjs", () => {
  it("generates the values the artifact showed at its last sync (main@1809ec2)", () => {
    // The artifact's tokens.json as published at main@1809ec2. A deliberate
    // change to the site's tokens updates this copy in the same pull request.
    const artifact = JSON.parse(readFileSync(resolve(__dirname, "fixtures/artifact-tokens-1809ec2.json"), "utf8"));
    const r = run("--repo", repo, "--notes", notesFile);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(values(JSON.parse(r.out))).toEqual(values(artifact));
  });

  it("joins each token's usage note from the notes file", () => {
    const t = JSON.parse(run(...site({ notes: (n) => (n.spacing.tokens["space-2"] = "Gaps.") })).out);
    expect(t.spacing.tokens.find((x: Notes) => x.name === "space-2").usage).toBe("Gaps.");
  });

  it("takes a changed stylesheet value", () => {
    const t = JSON.parse(run(...site({ css: (s) => s.replace("--teal: #73daca;", "--teal: #00ffcc;") })).out);
    expect(t.color.tokens.find((x: Notes) => x.name === "teal").value).toEqual({ night: "#00ffcc", light: "#0d6856" });
  });

  it.each([
    ["a colour with no note", { css: (s: string) => s.replace(/(--red: #\w+;)/g, "$1\n  --pink: #ff00ff;") }, "pink"],
    ["a note with no colour", { notes: (n: Notes) => (n.color.tokens.pink = "Nothing.") }, "pink"],
    ["a shadow with no note", { css: (s: string) => s + "\n.soft-shadow { box-shadow: 0 0 4px var(--bg); }\n" }, "soft-shadow"],
    ["a note with no shadow", { notes: (n: Notes) => (n.shadow.tokens["soft-shadow"] = "Nothing.") }, "soft-shadow"],
    ["a font family with no note", { notes: (n: Notes) => delete n.type.families.sans }, "sans"],
  ])("fails on %s, naming the token", (_, edit, name) => {
    const r = run(...site(edit));
    expect(r.code).toBe(1);
    expect(r.err).toContain(`token ${name}:`);
  });

  it.each([
    ["a colour", { css: (s: string) => s.replace("--teal: #73daca;", "--teal: tealish;") }, "teal"],
    ["a spacing step Tailwind has no class for", { notes: (n: Notes) => (n.spacing.tokens["space-x"] = "Nothing.") }, "space-x"],
    ["a container class that sets no width", { notes: (n: Notes) => (n.container.tokens["container-page"].class = "max-w-nope") }, "container-page"],
    ["a type style class that sets no size", { notes: (n: Notes) => (n.type.groups[0].styles[0].class = "font-bold") }, "hero-name"],
    ["a font family layout.tsx doesn't load", { layout: (s: string) => s.replace('"--font-geist-sans"', '"--font-other"') }, "sans"],
  ])("fails on %s it can't parse, naming the token", (_, edit, name) => {
    const r = run(...site(edit));
    expect(r.code).toBe(1);
    expect(r.err).toContain(`token ${name}:`);
  });
});
