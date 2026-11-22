import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The agent's rate limits and global ceilings live in memory, which is only
// correct on one instance (ADR 0003, amendment). So every command in the
// workflows that deploys or reconfigures the agent's Cloud Run service pins
// the maximum instance count to 1, and none may raise it.
const root = resolve(__dirname, "..");
const workflowsDir = ".github/workflows";
const workflows = readdirSync(join(root, workflowsDir))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ path: `${workflowsDir}/${f}`, text: readFileSync(join(root, workflowsDir, f), "utf8") }));

/** Each `gcloud run ...` command on the agent, with a folded `>-` block joined into one line. */
function agentRunCommands(text: string): string[] {
  const joined = text.replace(/\n\s+(?=--)/g, " ");
  return [...joined.matchAll(/gcloud run (?:deploy|services update(?!-traffic)) agent\b[^\n]*/g)].map((m) => m[0]);
}

describe("the agent's deploy", () => {
  const commands = workflows.flatMap(({ path, text }) =>
    agentRunCommands(text).map((command) => ({ path, command })),
  );

  it("is deployed from a workflow", () => {
    expect(commands.filter(({ command }) => command.startsWith("gcloud run deploy agent"))).not.toEqual([]);
  });

  it("pins the maximum instance count to 1 wherever it deploys or reconfigures the service", () => {
    const unpinned = commands.filter(({ command }) => {
      const max = [...command.matchAll(/--max(?:-instances)?[ =](\S+)/g)].map((m) => m[1].replace(/"/g, ""));
      return max.length === 0 || max.some((value) => value !== "1");
    });
    expect(unpinned).toEqual([]);
  });
});
