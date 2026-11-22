import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { longParagraphs, opening } from "./doc-length";
import { repoFiles, repoRoot as root } from "./repo-files";

// The docs are read by reviewers who want the decisions fast: each opens with
// a short what-and-why, and no paragraph runs long. ADRs and research notes
// are records, not guides, so they are left out.
const maxParagraphWords = 120;
const maxOpeningWords = 80;

function guideDocs(): string[] {
  return repoFiles().filter((path) => /^docs\/(agents\/)?[^/]+\.md$/.test(path));
}

describe("longParagraphs", () => {
  it("finds a paragraph over the limit and gives its first words", () => {
    const long = Array.from({ length: 6 }, (_, i) => `word${i}`).join(" ");
    expect(longParagraphs(`# T\n\nshort one\n\n${long}`, 5)).toEqual([{ words: 6, start: "word0 word1 word2 word3 word4 word5" }]);
  });

  it("counts a paragraph across its lines, and each list item on its own", () => {
    expect(longParagraphs("a b c\nd e f", 5)).toEqual([{ words: 6, start: "a b c d e f" }]);
    expect(longParagraphs("- a b c\n- d e f", 5)).toEqual([]);
    expect(longParagraphs("1. a b c\n   d e f", 5)).toEqual([{ words: 7, start: "1. a b c d e" }]);
  });

  it("skips code blocks, tables, headings and HTML comments", () => {
    const words = "a b c d e f";
    const markdown = [`\`\`\`\n${words}\n\`\`\``, `| ${words} |\n| --- |`, `## ${words}`, `<!-- ${words} -->`].join("\n\n");
    expect(longParagraphs(markdown, 5)).toEqual([]);
  });
});

describe("opening", () => {
  it("is the first paragraph after the title", () => {
    expect(opening("# Title\n\nWhat it is and why.\nSecond line.\n\n## Part\n\nMore.")).toBe("What it is and why. Second line.");
  });

  it("is missing when the title is followed by a heading, code or a table", () => {
    expect(opening("# Title\n\n## Part\n\ntext")).toBeUndefined();
    expect(opening("# Title\n\n```bash\npnpm dev\n```")).toBeUndefined();
    expect(opening("# Title\n\n| a |\n| --- |")).toBeUndefined();
  });
});

describe("the docs", () => {
  it("covers the guides", () => {
    expect(guideDocs()).toEqual(expect.arrayContaining(["docs/guardrails.md", "docs/agents/domain.md"]));
    expect(guideDocs()).not.toContain("docs/adr/0001-agent-evals-record-replay.md");
  });

  it.each(guideDocs())("%s opens with a short what-and-why", (path) => {
    const text = opening(readFileSync(join(root, path), "utf8"));
    expect(text, "no paragraph right after the title").toBeDefined();
    expect(text!.split(/\s+/).length).toBeLessThanOrEqual(maxOpeningWords);
  });

  it.each(guideDocs())(`%s has no paragraph over ${maxParagraphWords} words`, (path) => {
    expect(longParagraphs(readFileSync(join(root, path), "utf8"), maxParagraphWords)).toEqual([]);
  });
});
