import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The detection hooks, run as Claude Code runs them: the hook input on stdin,
// JSON on stdout. Every git call goes to a throwaway clone whose origin is a
// bare repo in a temp folder, never to GitHub. The clone's commits carry a
// stub build.mjs, so the real sync command runs end to end in seconds.
const hook = resolve(__dirname, "scripts/detect.mjs");
const fixture = (name: string) => JSON.parse(readFileSync(resolve(__dirname, "scripts/fixtures", name), "utf8"));
const bash = fixture("bash-post-tool-use.json");
const sessionStart = fixture("session-start.json");
const artifact = "https://claude.ai/artifact/9dpLiwikKeXPNuD9Cj4uUz";
const skillDir = ".claude/skills/design-system-sync";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

// A build.mjs that writes a two-file project folder, as the real one writes many.
const stubBuild = `import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[2];
mkdirSync(out, { recursive: true });
writeFileSync(out + "/design-system.json", "{}\\n");
writeFileSync(out + "/README.md", "# Stub\\n");
`;

/** Writes the files of a commit with the sync pipeline (or without it). */
function populate(clone: string, { pipeline = true } = {}) {
  write(clone, "package.json", '{ "name": "stub", "private": true }\n');
  write(clone, "src/app/globals.css", "a {}\n");
  write(clone, "src/shared/profile.ts", "export {};\n");
  write(clone, "notes.txt", "unlisted\n");
  write(
    clone,
    `${skillDir}/sources.json`,
    JSON.stringify({
      artifact,
      tokens: ["src/app/globals.css"],
      content: ["src/shared/profile.ts"],
      skill: [`${skillDir}/scripts/build.mjs`],
    }),
  );
  write(clone, `${skillDir}/scripts/build.mjs`, stubBuild);
  if (pipeline) {
    write(clone, `${skillDir}/scripts/sync.mjs`, "// the sync command\n");
    write(clone, `${skillDir}/scripts/manifest.mjs`, "// the manifest\n");
  }
}

/**
 * A clone whose origin is a bare repo. `ds-synced` is at the first commit on
 * both; origin/main is a second commit that changes `change` (a listed file
 * by default). The scratchpad is a folder of its own.
 */
function repo({ change = "src/app/globals.css", pipeline = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "ds-detect-"));
  dirs.push(base);
  const origin = join(base, "origin.git");
  const clone = join(base, "clone");
  const scratchpad = join(base, "scratchpad");
  mkdirSync(scratchpad);
  git(base, "init", "--quiet", "--bare", "-b", "main", origin);
  git(base, "init", "--quiet", "-b", "main", clone);
  git(clone, "remote", "add", "origin", origin);
  populate(clone, { pipeline });
  git(clone, "add", "-A");
  git(clone, "commit", "--quiet", "-m", "synced");
  const synced = git(clone, "rev-parse", "HEAD");
  git(clone, "tag", "ds-synced", synced);
  git(clone, "push", "--quiet", "origin", "main", "refs/tags/ds-synced");
  write(clone, change, "changed\n");
  git(clone, "commit", "--quiet", "-am", "change");
  const main = git(clone, "rev-parse", "HEAD");
  git(clone, "push", "--quiet", "origin", "main");
  return { base, origin, clone, scratchpad, synced, main };
}

type Out = { systemMessage?: string; hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };

function run(stdin: unknown) {
  const r = spawnSync("node", [hook], { input: JSON.stringify(stdin), encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stderr: r.stderr, out: (r.stdout.trim() ? JSON.parse(r.stdout) : undefined) as Out | undefined };
}

const context = (out?: Out) => out?.hookSpecificOutput?.additionalContext ?? "";
const atStart = (clone: string, scratchpad: string) => ({ ...sessionStart, cwd: clone, scratchpad_dir: scratchpad });
const manifestIn = (text: string) => /sync manifest (\S+\.json)/.exec(text)?.[1] ?? "";

describe("the session-start hook", () => {
  it("syncs origin/main and instructs the agent when a listed file changed", () => {
    const { clone, scratchpad, main } = repo();
    const { status, out, stderr } = run(atStart(clone, scratchpad));
    expect(status, stderr).toBe(0);
    expect(out?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    const text = context(out);
    const path = manifestIn(text);
    expect(path).toContain(main);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    expect(manifest.commit).toBe(main);
    expect(manifest.publish.root.startsWith(scratchpad)).toBe(true);
    expect(existsSync(join(manifest.publish.root, "project/design-system.json"))).toBe(true);
    expect(text).toContain(artifact);
    expect(text).toMatch(/"read".*no path/);
    expect(text).toMatch(/"list".*scope "files"/);
  });

  it("counts a content file", () => {
    const { clone, scratchpad, main } = repo({ change: "src/shared/profile.ts" });
    expect(manifestIn(context(run(atStart(clone, scratchpad)).out))).toContain(main);
  });

  it("stays silent when no listed file changed", () => {
    const { clone, scratchpad } = repo({ change: "notes.txt" });
    const { status, out } = run(atStart(clone, scratchpad));
    expect(status).toBe(0);
    expect(out).toBeUndefined();
  });

  it("picks up a merge it has not fetched yet", () => {
    const { base, origin, clone, scratchpad } = repo({ change: "notes.txt" });
    const other = join(base, "other");
    git(base, "clone", "--quiet", origin, other);
    write(other, "src/app/globals.css", "merged on the web\n");
    git(other, "commit", "--quiet", "-am", "web merge");
    git(other, "push", "--quiet", "origin", "main");
    const merged = git(other, "rev-parse", "HEAD");
    expect(manifestIn(context(run(atStart(clone, scratchpad)).out))).toContain(merged);
  });

  it("tells the user why, and the agent nothing, when origin/main has no sync pipeline", () => {
    const { clone, scratchpad, main } = repo({ pipeline: false });
    const { status, out } = run(atStart(clone, scratchpad));
    expect(status).toBe(0);
    expect(context(out)).toBe("");
    expect(out?.systemMessage).toContain(main.slice(0, 7));
    expect(out?.systemMessage).toMatch(/sync pipeline/);
    expect(existsSync(join(scratchpad, "design-system-sync"))).toBe(false);
  });

  it("reports a failed fetch and gives no instruction", () => {
    const { clone, scratchpad } = repo();
    git(clone, "remote", "set-url", "origin", join(clone, "missing.git"));
    const { status, out } = run(atStart(clone, scratchpad));
    expect(status).toBe(0);
    expect(context(out)).toBe("");
    expect(out?.systemMessage).toMatch(/fetching origin failed/);
  });

  it("reports a ds-synced tag missing on origin and gives no instruction", () => {
    const { origin, clone, scratchpad } = repo();
    git(origin, "tag", "-d", "ds-synced");
    const { status, out } = run(atStart(clone, scratchpad));
    expect(status).toBe(0);
    expect(context(out)).toBe("");
    expect(out?.systemMessage).toMatch(/ds-synced tag is not on origin/);
  });
});

/** A Bash PostToolUse input for `command`, run from `clone`. */
const afterBash = (clone: string, scratchpad: string, command: string) => ({
  ...bash,
  cwd: clone,
  scratchpad_dir: scratchpad,
  tool_input: { ...bash.tool_input, command },
});

/** Pushes a change to `path` from a second clone, as a merge on GitHub's web page does. */
function mergeElsewhere(base: string, origin: string, path: string) {
  const other = join(base, "other");
  git(base, "clone", "--quiet", origin, other);
  write(other, path, "merged elsewhere\n");
  git(other, "commit", "--quiet", "-am", "merge");
  git(other, "push", "--quiet", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

describe("the merge hook", () => {
  it("fetches and instructs the agent when the merge changed a listed file", () => {
    const { base, origin, clone, scratchpad } = repo({ change: "notes.txt" });
    const merged = mergeElsewhere(base, origin, "src/app/globals.css");
    const { status, out } = run(afterBash(clone, scratchpad, "gh pr merge 12 --squash --delete-branch"));
    expect(status).toBe(0);
    expect(out?.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(manifestIn(context(out))).toContain(merged);
  });

  it("stays silent when the merge changed no listed file", () => {
    const { base, origin, clone, scratchpad } = repo({ change: "notes.txt" });
    mergeElsewhere(base, origin, "notes.txt");
    const { status, out } = run(afterBash(clone, scratchpad, "gh pr merge 12 --squash"));
    expect(status).toBe(0);
    expect(out).toBeUndefined();
  });

  it("does nothing after a failed merge, which Claude Code sends as PostToolUseFailure", () => {
    const { clone, scratchpad } = repo();
    const failed = {
      ...afterBash(clone, scratchpad, "gh pr merge 12 --squash"),
      hook_event_name: "PostToolUseFailure",
      tool_response: undefined,
      error: "Exit code 1\nX Pull request is not mergeable",
    };
    const { status, out } = run(failed);
    expect(status).toBe(0);
    expect(out).toBeUndefined();
  });

  it("does nothing after an unrelated Bash command, even with a sync pending", () => {
    const { clone, scratchpad } = repo();
    for (const command of ["git status", "gh pr view 12", "echo git fetch", "ls"]) {
      const { status, out } = run(afterBash(clone, scratchpad, command));
      expect(status).toBe(0);
      expect(out, command).toBeUndefined();
    }
    expect(existsSync(join(scratchpad, "design-system-sync"))).toBe(false);
  });
});

describe("the fetch and pull hook", () => {
  it("instructs the agent from the refs a fetch brought, with no network of its own", () => {
    const { base, origin, clone, scratchpad } = repo({ change: "notes.txt" });
    const merged = mergeElsewhere(base, origin, "src/app/globals.css");
    git(clone, "fetch", "--quiet", "origin");
    git(clone, "remote", "set-url", "origin", join(base, "unreachable.git"));
    const { status, out } = run(afterBash(clone, scratchpad, "git fetch origin"));
    expect(status).toBe(0);
    expect(manifestIn(context(out))).toContain(merged);
  });

  it("acts on a pull and on git -C ... fetch inside a longer command", () => {
    const { clone, scratchpad, main } = repo();
    for (const command of ["git pull --ff-only", `cd x && git -C ${clone} fetch --prune`]) {
      expect(manifestIn(context(run(afterBash(clone, scratchpad, command)).out)), command).toContain(main);
    }
  });

  it("stays silent when the fetch brought no change to a listed file", () => {
    const { base, origin, clone, scratchpad } = repo({ change: "notes.txt" });
    mergeElsewhere(base, origin, "src/app/globals.css");
    // Not fetched: the hook sees only the refs the call brought, here none.
    const { status, out } = run(afterBash(clone, scratchpad, "git fetch origin"));
    expect(status).toBe(0);
    expect(out).toBeUndefined();
  });

  it("reports a ds-synced tag missing in the clone and gives no instruction", () => {
    const { clone, scratchpad } = repo();
    git(clone, "tag", "-d", "ds-synced");
    const { status, out } = run(afterBash(clone, scratchpad, "git pull"));
    expect(status).toBe(0);
    expect(context(out)).toBe("");
    expect(out?.systemMessage).toMatch(/ds-synced tag is not in this clone/);
  });
});

describe("where the sync writes", () => {
  it("falls back to an ignored folder inside the working directory without a scratchpad", () => {
    const { clone, main } = repo();
    git(clone, "worktree", "add", "--quiet", "--detach", join(clone, "../linked"), "HEAD");
    const linked = join(clone, "../linked");
    const input: Record<string, unknown> = afterBash(linked, "", "git fetch");
    delete input.scratchpad_dir;
    const manifest = JSON.parse(readFileSync(manifestIn(context(run(input).out)), "utf8"));
    expect(manifest.commit).toBe(main);
    expect(manifest.publish.root).toBe(join(linked, "node_modules/.cache/design-system-sync", main));
  });
});

describe("the settings entries", () => {
  const settings = JSON.parse(readFileSync(resolve(__dirname, "../../settings.json"), "utf8"));
  type Hook = { command: string; timeout?: number };
  type Entry = { matcher?: string; hooks: Hook[] };
  const detecting = (event: string, matcher?: string): Hook[] =>
    ((settings.hooks[event] ?? []) as Entry[])
      .filter((e) => e.matcher === matcher)
      .flatMap((e) => e.hooks)
      .filter((h) => h.command.includes("scripts/detect.mjs"));

  it("run the hook after every Bash call and at every session start", () => {
    expect(detecting("PostToolUse", "Bash")).toHaveLength(1);
    expect(detecting("SessionStart")).toHaveLength(1);
  });

  it("give every hook a timeout, the detection hooks one longer than the sync's 17 minutes", () => {
    for (const entries of Object.values(settings.hooks) as Entry[][])
      for (const h of entries.flatMap((e) => e.hooks)) expect(h.timeout, h.command).toBeGreaterThan(0);
    for (const h of [...detecting("PostToolUse", "Bash"), ...detecting("SessionStart")])
      expect(h.timeout).toBeGreaterThan(17 * 60);
  });
});
