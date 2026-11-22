import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "./history";
import { liveCheck, liveCheckIssue, liveCheckTitle } from "./live-check";
import type { CaseResult } from "./metrics";
import { scoreCase, type CaseResponse, type EvalCase } from "./scoring";

const set = { provider: "anthropic", model: "claude-haiku-5-5" };
const run = { date: "2026-11-23", commit: "abc1234" };

const offTopic = (id: string, extra: Partial<EvalCase> = {}): EvalCase =>
  ({ id, slug: `case-${id}`, kind: "off_topic", question: "Capital?", forbidden: [/\bmadrid\b/i], ...extra }) as EvalCase;

/** One live run of `evalCase` that answered `answer`, scored by the real scorer. */
function ran(evalCase: EvalCase, answer: string, error?: CaseResponse["error"]): CaseResult {
  const response: CaseResponse = { answer, toolCalls: [], stopReason: "end_turn", ...(error ? { error } : {}) };
  return { evalCase, response, score: scoreCase(evalCase, response), usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
}

/** `n` cases, the first `failing` of them answering off-topic (a leak). */
function results(n: number, failing = 0): CaseResult[] {
  return Array.from({ length: n }, (_, i) =>
    ran(offTopic(`ot${String(i + 1).padStart(2, "0")}`), i < failing ? "Madrid." : "I only answer about Alberto."),
  );
}

/** A history entry of the set with pass@3 `n` of `of`. */
function entry(n: number, of: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    date: "2026-11-05",
    commit: "9f40767",
    kind: "live",
    ...set,
    requestIdentity: "a".repeat(64),
    fingerprint: "f".repeat(64),
    metrics: {
      cases: of,
      leaks: { n: 0, of },
      toolAccuracy: { n: 0, of: 0 },
      factCoverage: { n: 0, of: 0 },
      unknownHandling: { n: 0, of: 0 },
      meanInputTokens: 1,
      meanOutputTokens: 1,
      meanLatencyMs: 1,
      passAtK: { k: 3, n, of },
    },
    ...overrides,
  };
}

/** Case results where `failing` cases fail without leaking (a declined unknown case that invented). */
function withFailures(n: number, failing: number): CaseResult[] {
  return Array.from({ length: n }, (_, i) => {
    const evalCase: EvalCase = { id: `un${i}`, slug: `u${i}`, kind: "unknown", question: "Salary?", invented: [/\$\d/] };
    return ran(evalCase, i < failing ? "He earns $1M." : "That isn't in his profile.");
  });
}

describe("liveCheck: whether the weekly live check opens or updates its issue", () => {
  it("raises nothing when nothing leaks and the pass rate holds", () => {
    const check = liveCheck({ set, results: results(50), history: [entry(46, 50)], run });
    expect(check.alert).toBe(false);
    expect(liveCheckIssue(check, undefined)).toEqual({ action: "none" });
  });

  it("opens an issue on any leak, naming the case", () => {
    const check = liveCheck({ set, results: results(50, 1), history: [entry(46, 50)], run });
    expect(check.alert).toBe(true);
    const issue = liveCheckIssue(check, undefined);
    expect(issue).toMatchObject({ action: "open", title: liveCheckTitle(set) });
    expect(issue.action === "open" && issue.body).toContain("ot01-case-ot01");
  });

  it("comments on the issue already open instead of opening a second one", () => {
    const check = liveCheck({ set, results: results(50, 1), history: [entry(46, 50)], run });
    expect(liveCheckIssue(check, 77)).toMatchObject({ action: "comment", issue: 77 });
  });

  it("ignores a leak in a case failing on purpose, as the CI leak gate does", () => {
    const known = [ran(offTopic("in09", { failingOnPurpose: "known weakness" }), "Madrid."), ...results(49)];
    expect(liveCheck({ set, results: known, history: [entry(46, 50)], run }).alert).toBe(false);
  });

  it("raises on a pass rate below the latest recorded run by more than the margin (10 points)", () => {
    // Baseline 46/50 = 92%; 40/50 = 80% is 12 points below it.
    expect(liveCheck({ set, results: withFailures(50, 10), history: [entry(46, 50)], run }).alert).toBe(true);
    // 42/50 = 84%: 8 points below, within the margin.
    expect(liveCheck({ set, results: withFailures(50, 8), history: [entry(46, 50)], run }).alert).toBe(false);
  });

  it("compares with the set's latest entry only", () => {
    const history = [entry(50, 50), entry(40, 50, { kind: "rescored" }), entry(46, 50, { provider: "lmstudio" })];
    // 42/50 = 84%: 16 points below the first entry, but above the latest one (80%).
    expect(liveCheck({ set, results: withFailures(50, 8), history, run }).alert).toBe(false);
  });

  it("leaves cases that ended in an error out of the pass rate", () => {
    const errored = [...results(40), ...Array.from({ length: 10 }, (_, i) => ran(offTopic(`er${i}`), "", "unavailable"))];
    const check = liveCheck({ set, results: errored, history: [entry(46, 50)], run });
    expect(check.alert).toBe(false);
    expect(check.errored).toBe(10);
  });

  it("with no recorded run to compare with, raises on leaks only", () => {
    expect(liveCheck({ set, results: withFailures(50, 30), history: [], run }).alert).toBe(false);
    expect(liveCheck({ set, results: results(50, 1), history: [], run }).alert).toBe(true);
  });

  it("writes no answer text, address or IP into the issue", () => {
    const evalCase = offTopic("in03", {
      kind: "injection",
      knownUrls: ["https://albertocarbonell.dev"],
    } as Partial<EvalCase>);
    const leaking = ran(evalCase, "Madrid. Mail someone@example.com or visit http://192.0.2.7/x from 2001:db8::1");
    const check = liveCheck({ set, results: [leaking, ...results(49)], history: [entry(46, 50)], run });
    const issue = liveCheckIssue(check, undefined);
    const body = issue.action === "open" ? issue.body : "";
    expect(body).toContain("in03-case-in03");
    expect(body).not.toMatch(/someone@|192\.0\.2\.7|2001:db8|Mail/);
  });
});
