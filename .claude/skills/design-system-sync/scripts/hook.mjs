// PostToolUse hook: after Claude Code edits a file the Design System artifact
// is built from (sources.json), adds a reminder to re-sync it. Once per
// session, so a run of edits gives one reminder. `content` files (copy, eval
// results) change no design, so they don't count. Never blocks: any problem
// here exits quietly.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const skill = dirname(dirname(fileURLToPath(import.meta.url)));
  const repo = join(skill, "../../..");
  const input = JSON.parse(readFileSync(0, "utf8"));
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof file === "string") {
    const path = relative(repo, isAbsolute(file) ? file : join(input.cwd ?? repo, file));
    const sources = JSON.parse(readFileSync(join(skill, "sources.json"), "utf8"));
    const part = ["tokens", "assets", "mirrored", "bundle"].find((k) => sources[k]?.includes(path));
    const marker = join(tmpdir(), `design-system-sync-${String(input.session_id).replace(/\W/g, "")}`);
    if (part && !existsSync(marker)) {
      writeFileSync(marker, path);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext:
              `${path} feeds the Design System artifact (${part}, see .claude/skills/design-system-sync/sources.json). ` +
              "Once this change is merged, re-sync the artifact with the design-system-sync skill, " +
              "or tell the user it is now out of date.",
          },
        }),
      );
    }
  }
} catch {
  // A reminder is not worth failing an edit over.
}
