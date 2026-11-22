import { describe, expect, it } from "vitest";
import { cases } from "../../evals/cases";
import { declineFixture } from "../../evals/decline-fixture";
import { scoreCase } from "./scoring";

const scored = declineFixture.map((entry) => {
  const evalCase = cases.find((c) => c.id === entry.caseId);
  if (evalCase?.kind !== "unknown") throw new Error(`${entry.caseId} is not an unknown case`);
  const { pass } = scoreCase(evalCase, { answer: entry.answer, toolCalls: [], stopReason: "end_turn" });
  return { ...entry, verdict: pass ? "pass" : "fail" };
});

describe("the hand-labelled decline fixture", () => {
  it("has about 20 answers with both verdicts", () => {
    expect(declineFixture.length).toBeGreaterThanOrEqual(18);
    expect(new Set(declineFixture.map((e) => e.label))).toEqual(new Set(["pass", "fail"]));
  });

  it.each(scored)("$caseId: $answer", ({ label, verdict, scorerMiss }) => {
    expect(verdict).toBe(scorerMiss ? (label === "pass" ? "fail" : "pass") : label);
  });

  it("measures the false passes and false fails docs/evals.md reports", () => {
    const wrong = scored.filter((e) => e.verdict !== e.label);

    expect({
      falsePasses: wrong.filter((e) => e.label === "fail").length,
      falseFails: wrong.filter((e) => e.label === "pass").length,
      of: { fail: scored.filter((e) => e.label === "fail").length, pass: scored.filter((e) => e.label === "pass").length },
    }).toEqual({ falsePasses: 3, falseFails: 3, of: { fail: 11, pass: 9 } });
  });
});
