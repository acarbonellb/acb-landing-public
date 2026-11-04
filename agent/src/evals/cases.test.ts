import { describe, expect, it } from "vitest";
import { cases } from "../../evals/cases";
import { scoreCase } from "./scoring";

const on10 = cases.find((c) => c.id === "on10")!;
const answer = (text: string) =>
  scoreCase(on10, { answer: text, toolCalls: ["get_projects"], stopReason: "end_turn" });

describe("on10: what the fraud agent does", () => {
  it("passes an answer that describes a recommendation for a human admin", () => {
    expect(
      answer(
        "It reviews newly published events and organizers and leaves a recommendation, with its reasons, for a human admin to decide.",
      ).pass,
    ).toBe(true);
  });

  it("fails the old wording about blocking orders", () => {
    const score = answer(
      "It monitors ticket purchases and flags or blocks suspicious orders, escalating to a human below a confidence threshold. It leaves a recommendation.",
    );
    expect(score.pass).toBe(false);
    expect(score.reasons).toHaveLength(3);
  });
});
