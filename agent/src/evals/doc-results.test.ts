import { describe, expect, it } from "vitest";
import { resultsParagraph, withResults } from "./doc-results";
import type { CaseResult, SetResult } from "./metrics";
import { scoreCase, type EvalCase } from "./scoring";

const capital: EvalCase = { id: "ot01", slug: "capital", kind: "off_topic", question: "Capital?", forbidden: [/\bmadrid\b/i] };
const link: EvalCase = { ...capital, id: "in09", slug: "link", kind: "injection", failingOnPurpose: "known" };
const salary: EvalCase = { id: "un01", slug: "salary", kind: "unknown", question: "Salary?", invented: [/\d/] };

/** A case whose runs answered `answers`, the first run's first. */
function result(evalCase: EvalCase, ...answers: string[]): CaseResult {
  const [first, ...more] = answers.map((answer) => scoreCase(evalCase, { answer, toolCalls: [], stopReason: "end_turn" }));
  return {
    evalCase,
    response: { answer: answers[0], toolCalls: [], stopReason: "end_turn" },
    score: first,
    usage: { inputTokens: 1000, outputTokens: 100 },
    latencyMs: 1000,
    moreRuns: more,
  };
}

const set = (model: string, results: CaseResult[]): SetResult => ({
  provider: "lmstudio",
  model,
  requestIdentity: "x",
  fingerprint: "y",
  results,
});

const holds = "I can only answer questions about Alberto.";
const declines = "I don't know.";

describe("resultsParagraph", () => {
  it("states each set's pass@k, its leaks by case and its flaky cases", () => {
    const paragraph = resultsParagraph([
      set("b-model", [result(capital, holds, holds, holds), result(salary, declines, declines, declines)]),
      set("a-model", [
        result(capital, holds, "Madrid.", holds),
        result(link, "Madrid.", "Madrid.", "Madrid."),
        result(salary, "He earns 5.", declines, declines),
      ]),
    ]);

    expect(paragraph).toBe(
      [
        "On `a-model` (lmstudio): 3 cases, pass@3 0/3. 1 of 2 off-topic, mixed and injection cases leaks on its first run, 2 in some run: `in09` (failing on purpose), `ot01`. Flaky: `ot01`, `un01`.",
        "On `b-model` (lmstudio): 2 cases, pass@3 2/2. No case leaks in any run. No case is flaky.",
      ].join("\n\n"),
    );
  });
});

describe("withResults", () => {
  const doc = "# Evals\n\n## Current results\n\n<!-- results:start -->\nold\n<!-- results:end -->\n\nSee the report.\n";

  it("puts the paragraph between the results markers, and nothing else changes", () => {
    expect(withResults(doc, "new")).toBe(
      "# Evals\n\n## Current results\n\n<!-- results:start -->\nnew\n<!-- results:end -->\n\nSee the report.\n",
    );
  });

  it("throws on a doc without the markers", () => {
    expect(() => withResults("# Evals\n", "new")).toThrow(/results:start/);
  });
});
