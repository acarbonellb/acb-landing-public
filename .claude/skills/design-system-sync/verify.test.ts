import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The verification hook, run as Claude Code runs it: the PostToolUse input on
// stdin, JSON on stdout. Every git call goes to a throwaway clone whose origin
// is a bare repo in a temp folder, never to GitHub.
const hook = resolve(__dirname, "scripts/verify.mjs");
const recorded = JSON.parse(readFileSync(resolve(__dirname, "scripts/fixtures/artifact-list-files.json"), "utf8"));
const listed: { path: string; sha256: string }[] = recorded.tool_response.file_list.files;
const projectFiles = listed.filter((f) => f.path.startsWith("project/"));

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** A clone with two commits whose origin is a bare repo; ds-synced is at the first on both. */
function repo() {
  const base = mkdtempSync(join(tmpdir(), "ds-verify-"));
  dirs.push(base);
  const origin = join(base, "origin.git");
  const clone = join(base, "clone");
  git(base, "init", "--quiet", "--bare", origin);
  git(base, "init", "--quiet", "-b", "main", clone);
  git(clone, "remote", "add", "origin", origin);
  git(clone, "commit", "--quiet", "--allow-empty", "-m", "old");
  const old = git(clone, "rev-parse", "HEAD");
  git(clone, "commit", "--quiet", "--allow-empty", "-m", "new");
  const commit = git(clone, "rev-parse", "HEAD");
  git(clone, "push", "--quiet", "origin", "main");
  git(clone, "tag", "ds-synced", old);
  git(clone, "push", "--quiet", "origin", "refs/tags/ds-synced");
  return { origin, clone, old, commit };
}

/** Writes the sync manifest for `commit` listing `files`, where sync.mjs puts it. */
function manifest(clone: string, commit: string, files = projectFiles) {
  const common = git(clone, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const root = "/tmp/ds-sync";
  const entries = files.map((f) => ({ path: f.path, file: join(root, f.path), contentType: "text/plain", sha256: f.sha256 }));
  const path = join(common, "design-system-sync", `${commit}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      format: 1,
      commit,
      ref: `main@${commit.slice(0, 7)}`,
      artifact: recorded.tool_input.url,
      root,
      files: entries,
      publish: {
        url: recorded.tool_input.url,
        root,
        file_path: join(root, "project/design-system.json"),
        files: Object.fromEntries(entries.map((e) => [e.path, { from: e.path, contentType: e.contentType }])),
      },
    }),
  );
}

/** The recorded input with its listing's files replaced by `files`, run from `cwd`. */
function input(cwd: string, files: unknown = listed, overrides: Record<string, unknown> = {}) {
  return {
    ...recorded,
    cwd,
    tool_response: { file_list: { ...recorded.tool_response.file_list, files } },
    ...overrides,
  };
}

function run(stdin: unknown) {
  const r = spawnSync("node", [hook], { input: JSON.stringify(stdin), encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, out: r.stdout.trim() ? JSON.parse(r.stdout) : undefined };
}

const remoteTag = (origin: string) => git(origin, "rev-parse", "refs/tags/ds-synced");
const context = (out: { hookSpecificOutput?: { additionalContext?: string } }) => out.hookSpecificOutput?.additionalContext ?? "";

describe("the verification hook", () => {
  it("moves ds-synced to the manifest's commit and pushes it when the listing matches", () => {
    const { origin, clone, commit } = repo();
    manifest(clone, commit);
    const { status, out } = run(input(clone));
    expect(status).toBe(0);
    expect(remoteTag(origin)).toBe(commit);
    expect(git(clone, "rev-parse", "refs/tags/ds-synced")).toBe(commit);
    expect(out.systemMessage).toContain(commit.slice(0, 7));
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });

  it("leaves ds-synced and names the paths when a hash differs", () => {
    const { origin, clone, old, commit } = repo();
    manifest(clone, commit);
    const changed = listed.map((f) =>
      f.path === "project/components/bundle.js" ? { ...f, sha256: "0".repeat(64) } : f,
    );
    const { status, out } = run(input(clone, changed));
    expect(status).toBe(0);
    expect(remoteTag(origin)).toBe(old);
    expect(git(clone, "rev-parse", "refs/tags/ds-synced")).toBe(old);
    expect(context(out)).toContain("project/components/bundle.js");
    expect(context(out)).not.toContain("project/tokens.json");
    expect(out.systemMessage).toMatch(/not verified/i);
  });

  it("leaves ds-synced and gives the removal publish for a file the manifest doesn't list", () => {
    const { origin, clone, old, commit } = repo();
    const gone = "project/components/Tag/preview.html";
    manifest(clone, commit, projectFiles.filter((f) => f.path !== gone));
    const { status, out } = run(input(clone));
    expect(status).toBe(0);
    expect(remoteTag(origin)).toBe(old);
    const text = context(out);
    const publish = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(publish).toEqual({
      url: "https://claude.ai/artifact/9dpLiwikKeXPNuD9Cj4uUz",
      file_path: "/tmp/ds-sync/project/design-system.json",
      files: { [gone]: null },
    });
    // The artifact type's own files are never leftovers.
    expect(text).not.toContain("SKILL.md");
    expect(text).not.toContain("artifact-type/");
  });

  it("reports a failed push without blocking and leaves the local tag", () => {
    const { clone, old, commit } = repo();
    manifest(clone, commit);
    git(clone, "remote", "set-url", "origin", join(clone, "no-such-origin.git"));
    const { status, out } = run(input(clone));
    expect(status).toBe(0);
    expect(git(clone, "rev-parse", "refs/tags/ds-synced")).toBe(old);
    expect(out.systemMessage).toMatch(/pushing ds-synced failed/);
    expect(out).not.toHaveProperty("decision");
  });

  it("runs after every Artifact call, with a timeout, from the project settings", () => {
    const settings = JSON.parse(readFileSync(resolve(__dirname, "../../settings.json"), "utf8"));
    const entries = settings.hooks.PostToolUse.filter((e: { matcher: string }) => e.matcher === "Artifact");
    const hooks = entries.flatMap((e: { hooks: { command: string; timeout?: number }[] }) => e.hooks);
    const ours = hooks.filter((h: { command: string }) => h.command.includes("scripts/verify.mjs"));
    expect(ours).toHaveLength(1);
    expect(ours[0].timeout).toBeGreaterThan(0);
    expect(ours[0].timeout).toBeLessThanOrEqual(60);
  });

  it.each([
    ["a text response", { tool_response: "82 files" }],
    ["no file_list", { tool_response: { files: listed } }],
    ["files that aren't a list", { tool_response: { file_list: { url: recorded.tool_input.url, files: {} } } }],
    ["an entry with a short hash", { tool_response: { file_list: { url: recorded.tool_input.url, files: listed.map((f) => ({ ...f, sha256: f.sha256.slice(0, 32) })) } } }],
    ["an entry with no path", { tool_response: { file_list: { url: recorded.tool_input.url, files: [...listed, { sha256: "a".repeat(64) }] } } }],
  ])("leaves ds-synced and reports a failure for %s", (_, overrides) => {
    const { origin, clone, old, commit } = repo();
    manifest(clone, commit);
    const { status, out } = run(input(clone, listed, overrides));
    expect(status).toBe(0);
    expect(remoteTag(origin)).toBe(old);
    expect(out.systemMessage).toMatch(/verification failed/i);
  });

  it.each([
    ["a read", { tool_input: { action: "read", url: recorded.tool_input.url } }],
    ["a publish", { tool_input: { url: recorded.tool_input.url, file_path: "/tmp/ds-sync/project/design-system.json" } }],
    ["a list of the gallery", { tool_input: { action: "list", scope: "mine" } }],
    ["a list of another artifact's files", { tool_input: { action: "list", scope: "files", url: "https://claude.ai/artifact/other" } }],
    ["another tool", { tool_name: "Bash" }],
  ])("does nothing on %s", (_, overrides) => {
    const { origin, clone, old, commit } = repo();
    manifest(clone, commit);
    const { status, stdout } = run(input(clone, listed, overrides));
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(remoteTag(origin)).toBe(old);
  });

  it("reports a failure when no sync wrote a manifest", () => {
    const { origin, clone, old } = repo();
    const { status, out } = run(input(clone));
    expect(status).toBe(0);
    expect(remoteTag(origin)).toBe(old);
    expect(out.systemMessage).toMatch(/verification failed/i);
    expect(context(out)).toMatch(/sync\.mjs/);
  });
});
