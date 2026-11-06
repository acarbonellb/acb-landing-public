import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commentedFile, issueReferencesInComments } from "./issue-refs";

// Code comments say why in words, so the code reads without the tracker open.
// Issue numbers belong in commit messages and PR descriptions; ADRs and
// research notes (Markdown) keep theirs. The planted references are built at
// run time, so this file passes its own tree check.
const ref = (n: number) => `#${n}`;

describe("issueReferencesInComments", () => {
  it("finds a reference in a line, block, doc or JSX comment of TypeScript", () => {
    const source = [
      `// Deploy what was tested (${ref(94)}).`,
      "const a = 1;",
      `/* the CSP, ${ref(93)} */`,
      "/**",
      ` * How he runs agents (${ref(43)}).`,
      " */",
      `const b = <p>{/* ${ref(50)} */}</p>;`,
      `const c = 2; // trailing ${ref(7)}`,
    ].join("\n");

    expect(issueReferencesInComments("x.tsx", source)).toEqual([
      `x.tsx:1: ${ref(94)}`,
      `x.tsx:3: ${ref(93)}`,
      `x.tsx:5: ${ref(43)}`,
      `x.tsx:7: ${ref(50)}`,
      `x.tsx:8: ${ref(7)}`,
    ]);
  });

  it("finds a reference in a shell, YAML or Dockerfile comment", () => {
    expect(issueReferencesInComments("s.sh", `#!/bin/sh\n# the probe (${ref(36)})\necho hi`)).toEqual([
      `s.sh:2: ${ref(36)}`,
    ]);
    expect(issueReferencesInComments("w.yml", `jobs:\n  a: 1 # see ${ref(65)}`)).toEqual([
      `w.yml:2: ${ref(65)}`,
    ]);
    expect(issueReferencesInComments("agent/Dockerfile", `# pinned (${ref(94)})\nFROM node`)).toEqual([
      `agent/Dockerfile:1: ${ref(94)}`,
    ]);
  });

  it("finds a link to an issue or a pull request", () => {
    const source = "// see https://github.com/o/r/issues/12 and https://github.com/o/r/pull/3";
    expect(issueReferencesInComments("a.ts", source)).toEqual(["a.ts:1: issues/12", "a.ts:1: pull/3"]);
  });

  it("leaves code, strings and look-alikes alone", () => {
    const source = [
      `const note = "a scorer change (${ref(99)})";`,
      "const at = /&#0*64;|&#x0*40;/g; // HTML entities for the @",
      "const url = `/a#2`;",
      "// The words in a comment, with no number.",
    ].join("\n");
    expect(issueReferencesInComments("a.ts", source)).toEqual([]);
    expect(issueReferencesInComments("s.sh", `echo "$#"\nX="${ref(1)}"`)).toEqual([]);
  });
});

describe("commentedFile", () => {
  it("covers source, tests, scripts and workflows, not Markdown, data or styles", () => {
    for (const path of [
      "src/a.tsx",
      "agent/src/b.ts",
      "scripts/c.mts",
      "eslint.config.mjs",
      "scripts/d.sh",
      ".github/workflows/deploy.yml",
      "agent/Dockerfile",
    ]) {
      expect(commentedFile(path), path).toBe(true);
    }
    for (const path of ["docs/adr/0001-x.md", "README.md", "package.json", "src/app/globals.css"]) {
      expect(commentedFile(path), path).toBe(false);
    }
  });
});

describe("the repo's code comments", () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path && commentedFile(path) && existsSync(join(root, path)));

  it("are scanned across the tree", () => {
    expect(files).toEqual(
      expect.arrayContaining([".github/workflows/deploy.yml", "agent/src/tools.ts", "src/shared/profile.ts"]),
    );
  });

  it("hold no issue reference: they give the reason in words", () => {
    const hits = files.flatMap((path) => issueReferencesInComments(path, readFileSync(join(root, path), "utf8")));
    expect(hits).toEqual([]);
  });
});
