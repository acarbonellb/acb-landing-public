import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentProject } from "@/shared/profile";
import { deployedSet, evalResultsLine, withEvalResults } from "./eval-results";

function line(entry: {
  provider: string;
  model: string;
  cases: number;
  leaks: number;
  of?: number;
  meanCostUsd?: number;
}): string {
  const { provider, model, cases, leaks, of = 19, meanCostUsd } = entry;
  return JSON.stringify({
    date: "2026-11-05",
    commit: "abc1234",
    provider,
    model,
    promptHash: "a".repeat(64),
    metrics: {
      cases,
      leaks: { n: leaks, of },
      toolAccuracy: { n: 11, of: 11 },
      factCoverage: { n: 22, of: 22 },
      unknownHandling: { n: 11, of: 11 },
      meanInputTokens: 2788,
      meanOutputTokens: 166,
      meanLatencyMs: 1651,
      ...(meanCostUsd === undefined ? {} : { meanCostUsd }),
    },
  });
}

const haiku = { provider: "anthropic", model: "claude-haiku-5-5" };
const qwen = { provider: "lmstudio", model: "qwen/qwen3.5-9b" };

/** An eval report with a case table per set, as `pnpm agent:eval:replay` writes it. */
function report(sets: { label: string; kinds: string[] }[]): string {
  return [
    "# Agent evals",
    "",
    ...sets.flatMap(({ label, kinds }) => [
      `## ${label}`,
      "",
      "| Case | Kind | Expected | Actual | Result |",
      "| --- | --- | --- | --- | --- |",
      ...kinds.map((kind, i) => `| c${i}-case | ${kind} | no leak | answer \\| more | pass |`),
      "",
    ]),
  ].join("\n");
}

const withInjection = report([
  { label: "anthropic / claude-haiku-5-5", kinds: ["on_topic", "off_topic", "injection"] },
  { label: "lmstudio / qwen/qwen3.5-9b", kinds: ["on_topic"] },
]);
const files = (history: string, text = withInjection) => ({ history, report: text });
const readRepoFile = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("evalResultsLine", () => {
  it("summarises the latest Claude Haiku 5.5 run: cases, leaks, cost per answer, CI", () => {
    const history = [
      line({ ...haiku, cases: 30, leaks: 1 }),
      line({ ...haiku, cases: 42, leaks: 0, meanCostUsd: 0.000362 }),
      line({ ...qwen, cases: 42, leaks: 2, meanCostUsd: 0 }),
      "",
    ].join("\n");

    expect(evalResultsLine(files(history))).toBe(
      "42 eval cases incl. prompt injection · 0 leaks · ~$0.0004 per answer on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("says a single leak in the singular, and rounds the cost to one significant digit", () => {
    const history = line({ ...haiku, cases: 40, leaks: 1, meanCostUsd: 0.00096 });

    expect(evalResultsLine(files(history))).toBe(
      "40 eval cases incl. prompt injection · 1 leak · ~$0.001 per answer on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("names the model without a cost when the latest run has none", () => {
    expect(evalResultsLine(files(line({ ...haiku, cases: 30, leaks: 0 })))).toBe(
      "30 eval cases incl. prompt injection · 0 leaks · on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("mentions prompt injection only when the deployed set has injection cases", () => {
    const history = line({ ...haiku, cases: 3, leaks: 0 });
    // Only another set has injection cases.
    const elsewhere = report([
      { label: "anthropic / claude-haiku-5-5", kinds: ["on_topic", "off_topic", "mixed"] },
      { label: "lmstudio / qwen/qwen3.5-9b", kinds: ["injection"] },
    ]);
    const plain = "3 eval cases · 0 leaks · on Claude Haiku 5.5 · replayed in CI";

    expect(evalResultsLine(files(history, elsewhere))).toBe(plain);
    expect(evalResultsLine(files(history, ""))).toBe(plain);
  });

  it("has no line without a Claude Haiku 5.5 run", () => {
    expect(evalResultsLine(files(""))).toBeUndefined();
    expect(
      evalResultsLine(files(line({ ...qwen, cases: 42, leaks: 0, meanCostUsd: 0 }))),
    ).toBeUndefined();
  });

  it("names the line of a malformed entry", () => {
    expect(() =>
      evalResultsLine(files(`${line({ ...haiku, cases: 1, leaks: 0 })}\nnot json`)),
    ).toThrow(/history\.jsonl line 2/);
    expect(() => evalResultsLine(files('{"provider":"anthropic"}'))).toThrow(
      /history\.jsonl line 1/,
    );
  });

  it("reads a line from the committed history and report", () => {
    const committed = {
      history: readRepoFile("agent/evals/history.jsonl"),
      report: readRepoFile("agent/evals/report.md"),
    };

    expect(evalResultsLine(committed)).toMatch(
      /^\d+ eval cases incl\. prompt injection · \d+ leaks? · ~\$[\d.]+ per answer on Claude Haiku 5\.5 · replayed in CI$/,
    );
  });

  it("is about the model the agent runs on by default", () => {
    // Read as text: the site must not import the agent's runtime code.
    const config = readRepoFile("agent/src/config.ts");
    const defaultModel = /^const defaultModel = "([^"]+)";$/m.exec(config)?.[1];

    expect(defaultModel).toBeDefined();
    expect(deployedSet.model).toBe(defaultModel);
  });
});

describe("withEvalResults", () => {
  const agentProjects: AgentProject[] = [
    { slug: "fraud-detection-agent", name: "Fraud", context: "c", description: "d", stack: [] },
    { slug: "portfolio-agent", name: "Portfolio Agent", context: "c", description: "d", stack: [] },
  ];

  it("puts the line on the Portfolio Agent card only", () => {
    const history = line({ ...haiku, cases: 42, leaks: 0, meanCostUsd: 0.000362 });

    const [fraud, portfolio] = withEvalResults(agentProjects, files(history));

    expect(fraud).toEqual(agentProjects[0]);
    expect(portfolio.result).toBe(evalResultsLine(files(history)));
  });

  it("leaves the cards as they are without a line", () => {
    expect(withEvalResults(agentProjects, files(""))).toEqual(agentProjects);
  });
});
