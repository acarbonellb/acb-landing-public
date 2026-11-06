import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Which CI jobs run for which trigger (`.github/workflows/deploy.yml`): every
// change gets the PR checks, the ranges refresh's dispatched run included
// (GITHUB_TOKEN's pushes start no workflows, so that PR only
// gets checks from the run it dispatches), and only `main` deploys.
const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Each job of a workflow with its job-level `if:` expression, if any. */
function jobConditions(workflow: string): Record<string, string | undefined> {
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const conditions: Record<string, string | undefined> = {};
  let job: string | undefined;
  for (const line of jobs.split("\n")) {
    const name = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/)?.[1];
    if (name) conditions[(job = name)] = undefined;
    const condition = line.match(/^ {4}if:\s*(.+)$/)?.[1];
    if (job && condition) conditions[job] = condition;
  }
  return conditions;
}

type Trigger = { event: string; ref: string };

/**
 * Evaluates a job's `if:` for `trigger`, with every repository variable set.
 * Handles what the workflow uses: `==`, `!=`, `&&`, `||`, `!`, parentheses
 * and single-quoted strings over `github.event_name`, `github.ref` and `vars.*`.
 */
function runs(condition: string | undefined, { event, ref }: Trigger): boolean {
  if (condition === undefined) return true;
  const js = condition
    .replace(/\bgithub\.event_name\b/g, JSON.stringify(event))
    .replace(/\bgithub\.ref\b/g, JSON.stringify(ref))
    .replace(/\bvars\.[A-Z_]+\b/g, JSON.stringify("set"))
    .replace(/'([^']*)'/g, (_, s: string) => JSON.stringify(s))
    .replace(/==/g, "===")
    .replace(/!=/g, "!==");
  expect(js).toMatch(/^[\s"a-zA-Z0-9/_.\-!=&|()]*$/);
  return Boolean(new Function(`return (${js});`)());
}

const deploy = jobConditions(read(".github/workflows/deploy.yml"));
const jobsFor = (trigger: Trigger) =>
  Object.entries(deploy)
    .filter(([, condition]) => runs(condition, trigger))
    .map(([job]) => job);

describe("CI jobs per trigger", () => {
  it("runs the PR checks on a pull request, and deploys nothing", () => {
    expect(jobsFor({ event: "pull_request", ref: "refs/pull/1/merge" })).toEqual([
      "test",
      "rehearse-deploy",
    ]);
  });

  it("runs the same PR checks on the run the ranges refresh dispatches on its branch", () => {
    expect(jobsFor({ event: "workflow_dispatch", ref: "refs/heads/ranges-refresh" })).toEqual([
      "test",
      "rehearse-deploy",
    ]);
  });

  it("deploys only from main", () => {
    expect(jobsFor({ event: "push", ref: "refs/heads/main" })).toEqual([
      "test",
      "deploy-agent",
      "deploy-site",
    ]);
    expect(jobsFor({ event: "push", ref: "refs/heads/feature" })).toEqual(["test"]);
  });

  it("is dispatched on the ranges-refresh branch by the refresh, which may do so", () => {
    const refresh = read(".github/workflows/ranges-refresh.yml");
    expect(refresh).toMatch(/gh workflow run deploy\.yml --ref "\$BRANCH"/);
    expect(refresh).toMatch(/^\s+actions: write\b/m);
  });
});
