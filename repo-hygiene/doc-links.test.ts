import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brokenLinks, headingAnchors, markdownLinks } from "./doc-links";

// The README is an overview that links into `docs/`, and the docs link to
// each other and to the code. A moved section or a renamed file must not
// leave a dead link behind, so every relative link and anchor in the README
// and the docs has to resolve. External links aren't fetched: CI stays
// offline.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function docFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path === "README.md" || (path.startsWith("docs/") && path.endsWith(".md")))
    .filter((path) => existsSync(join(root, path)));
}

describe("headingAnchors", () => {
  it("slugs headings the way GitHub does", () => {
    const anchors = headingAnchors(
      [
        "# Agent evals: record locally, replay in CI",
        "## Amendment (#99): the rule for changing a scorer",
        "### `GET /stats` and the `usage` document",
        "## Notes",
        "## Notes",
      ].join("\n"),
    );
    expect(anchors).toEqual(
      new Set([
        "agent-evals-record-locally-replay-in-ci",
        "amendment-99-the-rule-for-changing-a-scorer",
        "get-stats-and-the-usage-document",
        "notes",
        "notes-1",
      ]),
    );
  });

  it("ignores lines in code blocks that look like headings", () => {
    expect(headingAnchors("```bash\n# a comment\n```\n## Real")).toEqual(new Set(["real"]));
  });
});

describe("markdownLinks", () => {
  it("finds inline links outside code, with or without an anchor", () => {
    const text = [
      "See [the ADR](docs/adr/0001.md#consequences) and [below](#tests).",
      "An image ![x](assets/x.png) and a [site](https://example.com).",
      "`[not a link](nowhere.md)`",
      "```",
      "[also not](nowhere.md)",
      "```",
    ].join("\n");
    expect(markdownLinks(text)).toEqual([
      "docs/adr/0001.md#consequences",
      "#tests",
      "assets/x.png",
      "https://example.com",
    ]);
  });
});

describe("brokenLinks", () => {
  const files: Record<string, string> = {
    "README.md": "# Top\n[ok](docs/a.md#part) [bad file](docs/missing.md) [bad anchor](docs/a.md#nope) [self](#top)",
    "docs/a.md": "# A\n## Part\n[up](../README.md#top) [code](../src/x.ts) [dir](adr/)",
  };
  const read = (path: string) => files[path];
  const exists = (path: string) => path in files || path === "src/x.ts" || path === "docs/adr";

  it("names each link whose file or anchor doesn't exist", () => {
    expect(brokenLinks(Object.keys(files), read, exists)).toEqual([
      "README.md: docs/missing.md (no such file)",
      "README.md: docs/a.md#nope (no such heading)",
    ]);
  });
});

describe("the README and the docs", () => {
  const files = docFiles();

  it("are all checked", () => {
    expect(files).toEqual(expect.arrayContaining(["README.md", "docs/adr/0001-agent-evals-record-replay.md"]));
  });

  it("link only to files and headings that exist", () => {
    const read = (path: string) => readFileSync(join(root, path), "utf8");
    const exists = (path: string) => existsSync(join(root, path));
    expect(brokenLinks(files, read, exists)).toEqual([]);
  });
});
