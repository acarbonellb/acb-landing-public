import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The deploy pipeline ships what it tested, with nothing that can move under
// it between runs: actions by commit SHA, firebase-tools and every one of
// its dependencies by version and integrity, the agent's base image and the
// Firestore emulator the tests run against by version and digest, and no
// deploy job cancelled halfway.
const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const workflowsDir = ".github/workflows";
const workflows = readdirSync(join(root, workflowsDir))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ path: `${workflowsDir}/${f}`, text: read(`${workflowsDir}/${f}`) }));

describe("the deploy pipeline", () => {
  it("pins every action to a full commit SHA, with the version in a comment", () => {
    const uses = workflows.flatMap(({ path, text }) =>
      [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.+)$/gm)].map((m) => `${path}: ${m[1].trim()}`),
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((u) => !/@[0-9a-f]{40} # v\d+(\.\d+)*$/.test(u))).toEqual([]);
  });

  it("never cancels a running job", () => {
    const cancelling = workflows.filter(({ text }) => /cancel-in-progress:\s*true/.test(text));
    expect(cancelling.map((w) => w.path)).toEqual([]);
  });

  it("builds the agent image on a base pinned by version and digest", () => {
    const from = read("agent/Dockerfile").match(/^FROM\s+(\S+)/m)?.[1];
    expect(from).toMatch(/^node:\d+\.\d+\.\d+-slim@sha256:[0-9a-f]{64}$/);
  });

  it("runs the agent tests against a Firestore emulator image pinned by version and digest", () => {
    const ci = read(`${workflowsDir}/deploy.yml`);
    const emulator = ci.match(/^\s+firestore-emulator:\n\s+image:\s*(\S+)/m)?.[1];
    expect(emulator).toMatch(
      /^gcr\.io\/google\.com\/cloudsdktool\/google-cloud-cli:\d+\.\d+\.\d+-emulators@sha256:[0-9a-f]{64}$/,
    );
    // The agent tests point at it, so the contract suite's emulator run isn't skipped.
    expect(ci).toMatch(/- run: pnpm agent:test\n\s+env:\n\s+FIRESTORE_EMULATOR_HOST: localhost:\d+/);
    // The local instructions run the same image.
    expect(read("docs/development.md")).toContain(emulator);
  });

  it("pins every container image in the workflows by digest", () => {
    const images = workflows.flatMap(({ path, text }) =>
      [...text.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => `${path}: ${m[1]}`),
    );
    expect(images.filter((i) => !/@sha256:[0-9a-f]{64}$/.test(i))).toEqual([]);
  });

  it("deploys with a firebase-tools locked by version and integrity, dependencies included", () => {
    const manifest = JSON.parse(read("deploy/firebase-tools/package.json"));
    expect(manifest.dependencies["firebase-tools"]).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(read("deploy/firebase-tools/package-lock.json"));
    const packages = Object.entries(lock.packages as Record<string, { integrity?: string; link?: boolean }>)
      .filter(([path, p]) => path !== "" && !p.link);
    expect(packages.length).toBeGreaterThan(1);
    expect(packages.filter(([, p]) => !p.integrity?.startsWith("sha512-")).map(([path]) => path)).toEqual([]);
    expect(lock.packages["node_modules/firebase-tools"].version).toBe(manifest.dependencies["firebase-tools"]);
    // No unlocked install of it anywhere in the workflows.
    const unlocked = workflows.filter(({ text }) => /(dlx|npx|exec)\s+(-y\s+)?firebase-tools/.test(text));
    expect(unlocked.map((w) => w.path)).toEqual([]);
  });
});
