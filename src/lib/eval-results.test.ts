import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentProject } from "@/shared/profile";
import { deployedSet, evalResultsLine, withEvalResults } from "./eval-results";

type Kinds = Record<string, number>;

function set(entry: {
  provider: string;
  model: string;
  cases: number;
  leaks: number;
  kinds?: Kinds;
  meanCostUsd?: number;
  passAtK?: { k: number; n: number; of: number };
  forgedHistory?: number;
  failingOnPurpose?: { cases: number; leaks: number };
}) {
  const {
    provider,
    model,
    cases,
    leaks,
    kinds = { injection: 1, on_topic: cases - 1 },
    meanCostUsd,
    ...optional
  } = entry;
  return {
    provider,
    model,
    cases,
    kinds,
    leaks: { n: leaks, of: 19 },
    ...(meanCostUsd === undefined ? {} : { meanCostUsd }),
    ...optional,
  };
}

/** An eval summary, as `pnpm agent:eval:replay` writes it. */
const summary = (...sets: object[]) => `${JSON.stringify({ sets }, null, 2)}\n`;

const haiku = { provider: "anthropic", model: "claude-haiku-5-5" };
const qwen = { provider: "lmstudio", model: "qwen/qwen3.5-9b" };
const readRepoFile = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("evalResultsLine", () => {
  it("summarises the Claude Haiku 5.5 set: cases, leaks, cost per answer, CI", () => {
    const text = summary(
      set({ ...qwen, cases: 42, leaks: 2, meanCostUsd: 0 }),
      set({ ...haiku, cases: 42, leaks: 0, meanCostUsd: 0.000362 }),
    );

    expect(evalResultsLine(text)).toBe(
      "42 eval cases incl. prompt injection · 0 leaks · ~$0.0004 per answer on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("says a single leak in the singular, and rounds the cost to one significant digit", () => {
    const text = summary(set({ ...haiku, cases: 40, leaks: 1, meanCostUsd: 0.00096 }));

    expect(evalResultsLine(text)).toBe(
      "40 eval cases incl. prompt injection · 1 leak · ~$0.001 per answer on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("names the model without a cost when the set has none", () => {
    expect(evalResultsLine(summary(set({ ...haiku, cases: 30, leaks: 0 })))).toBe(
      "30 eval cases incl. prompt injection · 0 leaks · on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("mentions prompt injection only when the deployed set has injection cases", () => {
    const text = summary(
      set({ ...haiku, cases: 3, leaks: 0, kinds: { mixed: 1, off_topic: 1, on_topic: 1 } }),
      set({ ...qwen, cases: 1, leaks: 0, kinds: { injection: 1 } }),
    );

    expect(evalResultsLine(text)).toBe("3 eval cases · 0 leaks · on Claude Haiku 5.5 · replayed in CI");
  });

  it("ignores fields it doesn't use, such as ones added later", () => {
    const text = summary({ ...set({ ...haiku, cases: 30, leaks: 0 }), addedLater: { k: 3 } });

    expect(evalResultsLine(text)).toBe(
      "30 eval cases incl. prompt injection · 0 leaks · on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("states pass@k, rounded down so it never reads higher than it is", () => {
    const text = summary(set({ ...haiku, cases: 3, leaks: 0, passAtK: { k: 3, n: 2, of: 3 } }));

    expect(evalResultsLine(text)).toBe(
      "3 eval cases incl. prompt injection · pass@3 66% · 0 leaks · on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("mentions forged history when the deployed set has forged-history cases", () => {
    const text = summary(set({ ...haiku, cases: 30, leaks: 0, forgedHistory: 3 }));

    expect(evalResultsLine(text)).toBe(
      "30 eval cases incl. prompt injection and forged history · 0 leaks · on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("says which leaks come from cases failing on purpose, and still counts them", () => {
    const allKnown = summary(set({ ...haiku, cases: 30, leaks: 1, failingOnPurpose: { cases: 2, leaks: 1 } }));
    const someKnown = summary(set({ ...haiku, cases: 30, leaks: 3, failingOnPurpose: { cases: 1, leaks: 1 } }));
    const noneLeaked = summary(set({ ...haiku, cases: 30, leaks: 0, failingOnPurpose: { cases: 1, leaks: 0 } }));

    expect(evalResultsLine(allKnown)).toBe(
      "30 eval cases incl. prompt injection · 1 leak (failing on purpose) · on Claude Haiku 5.5 · replayed in CI",
    );
    expect(evalResultsLine(someKnown)).toBe(
      "30 eval cases incl. prompt injection · 3 leaks (1 failing on purpose) · on Claude Haiku 5.5 · replayed in CI",
    );
    expect(evalResultsLine(noneLeaked)).toBe(
      "30 eval cases incl. prompt injection · 0 leaks · on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("has no line without a Claude Haiku 5.5 set", () => {
    expect(evalResultsLine(summary())).toBeUndefined();
    expect(evalResultsLine(summary(set({ ...qwen, cases: 42, leaks: 0, meanCostUsd: 0 })))).toBeUndefined();
  });

  it("names the summary file when it's malformed", () => {
    expect(() => evalResultsLine("not json")).toThrow(/summary\.json: not JSON/);
    expect(() => evalResultsLine('{"sets":[{"provider":"anthropic"}]}')).toThrow(
      /summary\.json: not an eval summary/,
    );
  });

  it("reads the line from the committed summary, the failing-on-purpose leak counted and named", () => {
    expect(evalResultsLine(readRepoFile("agent/evals/summary.json"))).toBe(
      "50 eval cases incl. prompt injection and forged history · pass@1 98% · 1 leak (failing on purpose) · ~$0.0004 per answer on Claude Haiku 5.5 · replayed in CI",
    );
  });

  it("is built without the report's Markdown", () => {
    for (const path of ["src/lib/eval-results.ts", "src/app/page.tsx"]) {
      expect(readRepoFile(path)).not.toMatch(/report\.md|"report"/);
    }
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
    const text = summary(set({ ...haiku, cases: 42, leaks: 0, meanCostUsd: 0.000362 }));

    const [fraud, portfolio] = withEvalResults(agentProjects, text);

    expect(fraud).toEqual(agentProjects[0]);
    expect(portfolio.result).toBe(evalResultsLine(text));
  });

  it("leaves the cards as they are without a line", () => {
    expect(withEvalResults(agentProjects, summary())).toEqual(agentProjects);
  });
});
