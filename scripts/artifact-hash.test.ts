import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// CI hashes the build it tested and the copy each deploy job ships; a match
// means the deploy is byte-identical to what passed the tests (#94).
const script = resolve(__dirname, "artifact-hash.sh");

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fresh checkout-like directory holding `files` (path -> contents). */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "artifact-hash-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const hash = (cwd: string, ...paths: string[]) =>
  execFileSync("bash", [script, ...paths], { cwd, encoding: "utf8" }).trim();

const build = {
  "out/index.html": "<h1>hi</h1>",
  "out/_next/static/app.js": "console.log(1)",
  "out/firebase.json": "{}",
  "agent/dist/main.js": "export {}",
};

describe("artifact-hash.sh", () => {
  it("prints one sha256 for the given files and directories", () => {
    expect(hash(tree(build), "out", "agent/dist/main.js")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same hash for the same bytes wherever they are", () => {
    expect(hash(tree(build), "out", "agent/dist/main.js")).toBe(
      hash(tree(build), "out", "agent/dist/main.js"),
    );
  });

  it("changes when one byte of one file changes", () => {
    const changed = { ...build, "out/_next/static/app.js": "console.log(2)" };
    expect(hash(tree(changed), "out")).not.toBe(hash(tree(build), "out"));
  });

  it("changes when a file is added, even a hidden one", () => {
    const added = { ...build, "out/.extra": "" };
    expect(hash(tree(added), "out")).not.toBe(hash(tree(build), "out"));
  });

  it("changes when a file moves", () => {
    const root = tree(build);
    const before = hash(root, "out");
    renameSync(join(root, "out/index.html"), join(root, "out/home.html"));
    expect(hash(root, "out")).not.toBe(before);
  });

  it("fails on a missing or empty path instead of hashing nothing", () => {
    const root = tree(build);
    mkdirSync(join(root, "empty"));
    expect(() => hash(root, "missing")).toThrow();
    expect(() => hash(root, "empty")).toThrow();
    expect(() => hash(root)).toThrow();
  });
});
