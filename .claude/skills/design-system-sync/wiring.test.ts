import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// How the sync is wired into the repo: the sources list's `skill` part and the
// hooks in .claude/settings.json, read as they are on disk.
const repo = resolve(__dirname, "../../..");
const skill = relative(repo, __dirname);
const sources = JSON.parse(readFileSync(join(__dirname, "sources.json"), "utf8"));
const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));

const filesUnder = (dir: string): string[] =>
  readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );

type Hook = { matcher?: string; hooks: { command: string }[] };
const hooks: { event: string; matcher?: string; command: string }[] = Object.entries(
  settings.hooks as Record<string, Hook[]>,
).flatMap(([event, entries]) => entries.flatMap((e) => e.hooks.map((h) => ({ event, matcher: e.matcher, command: h.command }))));

describe("the sources list's skill part", () => {
  it("names only files that exist", () => {
    const missing = (sources.skill as string[]).filter((p) => !existsSync(join(repo, p)));
    expect(missing).toEqual([]);
  });

  it("names every hand-written file of the skill's project folder", () => {
    const written = filesUnder(join(skill, "project"));
    expect(written).toContain(`${skill}/project/components/AgentCard/README.md`);
    expect(written.filter((p) => !sources.skill.includes(p))).toEqual([]);
  });
});

describe("the hooks", () => {
  it("run scripts that exist", () => {
    const scripts = hooks.map((h) => /\$CLAUDE_PROJECT_DIR\/([^"]+)/.exec(h.command)?.[1]);
    expect(scripts).not.toContain(undefined);
    expect(scripts.filter((p) => !existsSync(join(repo, p!)))).toEqual([]);
  });

  it("are the detection hooks and the verification hook, and nothing on file edits", () => {
    const wired = hooks.map((h) => `${h.event} ${h.matcher ?? "*"} ${h.command.match(/scripts\/(\w+\.mjs)/)?.[1]}`);
    expect(wired.sort()).toEqual([
      "PostToolUse Artifact verify.mjs",
      "PostToolUse Bash detect.mjs",
      "SessionStart * detect.mjs",
    ]);
  });
});
