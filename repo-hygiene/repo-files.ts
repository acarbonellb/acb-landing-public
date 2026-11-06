// The files the tree-wide checks read: every file git would publish.
// Test-only, shared by the checks that run over the whole tree.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The checkout's root directory. */
export const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/**
 * Every file git would publish, relative to `repoRoot`: tracked, plus
 * untracked files that aren't ignored. A tracked file deleted in the working
 * tree is left out, since there is nothing to read.
 */
export function repoFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path && existsSync(join(repoRoot, path)));
}
