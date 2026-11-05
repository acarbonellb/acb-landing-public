import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addressForms,
  findAddresses,
  isPublicSafeAddress,
  maskAddress,
} from "./address-scan";

// The repo is public, so the contact address lives only in Secret Manager
// (#51). This scans every file git would publish: tracked, plus untracked
// files that aren't ignored.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function repoFiles(): { path: string; text: string }[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path && existsSync(join(root, path)))
    .map((path) => ({ path, text: readFileSync(join(root, path), "latin1") }));
}

describe("the repo tree", () => {
  const files = repoFiles();

  it("is scanned whole", () => {
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(["src/shared/profile.ts", "agent/evals/report.md", "README.md"]),
    );
  });

  it("holds no email address except on reserved test domains or listed third parties", () => {
    const hits = files.flatMap(({ path, text }) =>
      findAddresses(text)
        .filter((a) => !isPublicSafeAddress(a))
        .map((a) => `${path}: ${maskAddress(a)}`),
    );
    expect(hits).toEqual([]);
  });

  // Only where the address is known: your shell, never CI (the value must not
  // reach GitHub). Run `CONTACT_EMAIL=... pnpm test` before pushing.
  const contactEmail = process.env.CONTACT_EMAIL;
  it.skipIf(!contactEmail)("holds the CONTACT_EMAIL address in no form, plain or scrambled", () => {
    const forms = addressForms(contactEmail!);
    const hits = files.flatMap(({ path, text }) => {
      const lower = text.toLowerCase();
      return forms
        .filter(({ value }) => lower.includes(value.toLowerCase()))
        .map(({ label }) => `${path}: ${label}`);
    });
    expect([...new Set(hits)]).toEqual([]);
  });
});
