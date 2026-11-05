import { describe, expect, it } from "vitest";
import type { ChatClientEvent } from "./chat-client";
import {
  type Turn,
  answerWithFallback,
  endTurn,
  foldEvent,
  historyFor,
  isBusy,
  noticeOf,
  startTurn,
} from "./chat-session";

function fold(turn: Turn, ...events: ChatClientEvent[]): Turn {
  return events.reduce(foldEvent, turn);
}

function answered(id: number, question: string, answer: string): Turn {
  return fold(
    startTurn(id, question),
    { type: "text", delta: answer },
    { type: "done", stopReason: "end_turn" },
  );
}

describe("folding chat events into a turn", () => {
  it("starts streaming with the question and no parts", () => {
    expect(startTurn(3, "Who?")).toEqual({
      id: 3,
      question: "Who?",
      parts: [],
      status: { kind: "streaming" },
    });
  });

  it("joins text deltas and lists tool calls with their input between them", () => {
    const turn = fold(
      startTurn(0, "What?"),
      { type: "text", delta: "Let me " },
      { type: "text", delta: "check." },
      { type: "tool_call", id: "t1", name: "get_projects", input: {} },
      { type: "tool_call", id: "t2", name: "get_experience", input: { company: "Acme" } },
      { type: "text", delta: "Three agents." },
    );

    expect(turn.parts).toEqual([
      { kind: "text", text: "Let me check." },
      { kind: "tool", id: "t1", label: "get_projects()" },
      { kind: "tool", id: "t2", label: 'get_experience({"company":"Acme"})' },
      { kind: "text", text: "Three agents." },
    ]);
    expect(turn.status).toEqual({ kind: "streaming" });
  });

  it("is answered with the stop reason when the stream is done", () => {
    const turn = fold(
      startTurn(0, "What?"),
      { type: "text", delta: "Cut" },
      { type: "done", stopReason: "max_tokens" },
    );

    expect(turn.status).toEqual({ kind: "answered", stopReason: "max_tokens" });
  });

  it("fails with the error's notice and keeps the partial answer", () => {
    const turn = fold(
      startTurn(0, "What?"),
      { type: "text", delta: "Half an" },
      {
        type: "error",
        kind: "rate_limited",
        message: "Too many questions.",
        retryAfterSeconds: 42,
      },
    );

    expect(turn.parts).toEqual([{ kind: "text", text: "Half an" }]);
    expect(turn.status).toEqual({
      kind: "failed",
      notice: { kind: "rate_limited", message: "Too many questions.", retryAfterSeconds: 42 },
    });
  });

  it("fails without a notice when it ends still streaming (aborted)", () => {
    expect(endTurn(startTurn(0, "What?")).status).toEqual({ kind: "failed" });
    const done = answered(0, "Who?", "Alberto.");
    expect(endTurn(done)).toEqual(done);
  });

  it("is answered by the contact fallback, not failed", () => {
    const turn = answerWithFallback(startTurn(0, "Email?"), {
      kind: "tools",
      reason: "unavailable",
      email: "ada@example.com",
    });

    expect(turn.status).toEqual({
      kind: "fallback",
      fallback: { kind: "tools", reason: "unavailable", email: "ada@example.com" },
    });
    expect(endTurn(turn)).toEqual(turn);
  });
});

describe("the conversation's notice and busy state", () => {
  it("has no notice and is idle before any question", () => {
    expect(noticeOf([])).toBeNull();
    expect(isBusy([])).toBe(false);
  });

  it("shows the notice of the last turn when it failed", () => {
    const failed = fold(startTurn(1, "Q"), {
      type: "error",
      kind: "unavailable",
      message: "Monthly budget reached.",
      resetsAt: "2026-12-01T00:00:00.000Z",
    });

    expect(noticeOf([answered(0, "Who?", "Alberto."), failed])).toEqual({
      kind: "unavailable",
      message: "Monthly budget reached.",
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
  });

  it("clears the notice once the next question is asked, and is busy while it streams", () => {
    const failed = fold(startTurn(0, "Q1"), { type: "error", kind: "error" });
    const turns = [failed, startTurn(1, "Q2")];

    expect(noticeOf(turns)).toBeNull();
    expect(isBusy(turns)).toBe(true);
  });

  it("shows no notice for an aborted turn or a fallback answer", () => {
    expect(noticeOf([endTurn(startTurn(0, "Q"))])).toBeNull();
    expect(noticeOf([answerWithFallback(startTurn(0, "Q"), { kind: "linkedin" })])).toBeNull();
  });
});

describe("the history sent with the next question", () => {
  it("is just the question in a new conversation", () => {
    expect(historyFor([], "Who?")).toEqual([{ role: "user", content: "Who?" }]);
  });

  it("carries the answered exchanges before the new question, trimmed", () => {
    const turns = [
      fold(
        startTurn(0, "Who?"),
        { type: "text", delta: "  Let me look. " },
        { type: "tool_call", id: "t1", name: "get_profile", input: {} },
        { type: "text", delta: "Alberto.  " },
        { type: "done", stopReason: "end_turn" },
      ),
    ];

    expect(historyFor(turns, "Remote?")).toEqual([
      { role: "user", content: "Who?" },
      { role: "assistant", content: "Let me look. Alberto." },
      { role: "user", content: "Remote?" },
    ]);
  });

  it("leaves out failed, aborted, fallback and empty exchanges", () => {
    const turns = [
      fold(startTurn(0, "Failed"), { type: "text", delta: "Half" }, { type: "error", kind: "error" }),
      endTurn(fold(startTurn(1, "Aborted"), { type: "text", delta: "Half" })),
      answerWithFallback(startTurn(2, "Email?"), { kind: "linkedin" }),
      fold(startTurn(3, "Empty"), { type: "done", stopReason: "refusal" }),
      answered(4, "Who?", "Alberto."),
    ];

    expect(historyFor(turns, "Remote?")).toEqual([
      { role: "user", content: "Who?" },
      { role: "assistant", content: "Alberto." },
      { role: "user", content: "Remote?" },
    ]);
  });

  it("keeps the most recent exchanges that fit the message cap, each answer within the character cap", () => {
    // 20 messages per request: 9 exchanges plus the new question.
    const turns = Array.from({ length: 12 }, (_, i) => answered(i, `Q${i}`, `A${i}`));
    turns.push(answered(12, "Long", "x".repeat(2500)));

    const history = historyFor(turns, "Next");

    expect(history).toHaveLength(19);
    expect(history[0]).toEqual({ role: "user", content: "Q4" });
    expect(history.at(-2)).toEqual({ role: "assistant", content: "x".repeat(2000) });
    expect(history.at(-1)).toEqual({ role: "user", content: "Next" });
  });
});
