import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentProject } from "@/content/profile";
import { evalResultsLine, withEvalResults } from "./eval-results";

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

describe("evalResultsLine", () => {
  it("summarises the latest Claude Haiku 5.5 run: cases, leaks, cost per answer, CI", () => {
    const history = [
      line({ ...haiku, cases: 30, leaks: 1 }),
      line({ ...haiku, cases: 42, leaks: 0, meanCostUsd: 0.000362 }),
      line({ ...qwen, cases: 42, leaks: 2, meanCostUsd: 0 }),
      "",
    ].join("\n");

    expect(evalResultsLine(history)).toBe(
      "42 eval cases incl. prompt injection · 0 off-topic leaks · ~$0.0004 per answer on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("says a single leak in the singular, and rounds the cost to one significant digit", () => {
    const history = line({ ...haiku, cases: 40, leaks: 1, meanCostUsd: 0.00096 });

    expect(evalResultsLine(history)).toBe(
      "40 eval cases incl. prompt injection · 1 off-topic leak · ~$0.001 per answer on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("names the model without a cost when the latest run has none", () => {
    expect(evalResultsLine(line({ ...haiku, cases: 30, leaks: 0 }))).toBe(
      "30 eval cases incl. prompt injection · 0 off-topic leaks · on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("has no line without a Claude Haiku 5.5 run", () => {
    expect(evalResultsLine("")).toBeUndefined();
    expect(evalResultsLine(line({ ...qwen, cases: 42, leaks: 0, meanCostUsd: 0 }))).toBeUndefined();
  });

  it("names the line of a malformed entry", () => {
    expect(() => evalResultsLine(`${line({ ...haiku, cases: 1, leaks: 0 })}\nnot json`)).toThrow(
      /history\.jsonl line 2/,
    );
    expect(() => evalResultsLine('{"provider":"anthropic"}')).toThrow(/history\.jsonl line 1/);
  });

  it("reads a line from the committed history", () => {
    const history = readFileSync(join(process.cwd(), "agent/evals/history.jsonl"), "utf8");

    expect(evalResultsLine(history)).toMatch(
      /^\d+ eval cases incl\. prompt injection · \d+ off-topic leaks? · ~\$[\d.]+ per answer on Claude Haiku 5\.5 · replayed in CI$/,
    );
  });
});

describe("withEvalResults", () => {
  const agents: AgentProject[] = [
    { slug: "fraud-detection-agent", name: "Fraud", context: "c", description: "d", stack: [] },
    { slug: "portfolio-agent", name: "Portfolio Agent", context: "c", description: "d", stack: [] },
  ];

  it("puts the line on the Portfolio Agent card only", () => {
    const history = line({ ...haiku, cases: 42, leaks: 0, meanCostUsd: 0.000362 });

    const [fraud, portfolio] = withEvalResults(agents, history);

    expect(fraud).toEqual(agents[0]);
    expect(portfolio.result).toBe(evalResultsLine(history));
  });

  it("leaves the cards as they are without a line", () => {
    expect(withEvalResults(agents, "")).toEqual(agents);
  });
});
