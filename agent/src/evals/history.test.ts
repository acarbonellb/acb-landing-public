import { describe, expect, it } from "vitest";
import {
  appendHistory,
  checkHistory,
  historyEntry,
  parseHistory,
  renderHistory,
  type HistoryEntry,
} from "./history";
import type { Metrics, SetResult } from "./report";
import { scoreCase, type CaseOutcome, type EvalCase } from "./scoring";

const capital: EvalCase = {
  id: "ot01",
  slug: "capital",
  kind: "off_topic",
  question: "Capital?",
  forbidden: [/\bmadrid\b/i],
};

function setWith(answer: string, overrides: Partial<SetResult> = {}): SetResult {
  const outcome: CaseOutcome = { answer, toolCalls: [], stopReason: "end_turn" };
  return {
    provider: "lmstudio",
    model: "qwen/qwen3.5-9b",
    promptHash: "a".repeat(64),
    results: [
      {
        evalCase: capital,
        outcome,
        score: scoreCase(capital, outcome),
        usage: { inputTokens: 1000, outputTokens: 100 },
        latencyMs: 2000,
      },
    ],
    ...overrides,
  };
}

const cleanMetrics: Metrics = {
  cases: 1,
  offTopicLeaks: { n: 0, of: 1 },
  toolAccuracy: { n: 0, of: 0 },
  factCoverage: { n: 0, of: 0 },
  unknownHandling: { n: 0, of: 0 },
  meanInputTokens: 1000,
  meanOutputTokens: 100,
  meanLatencyMs: 2000,
};

const run = { date: "2026-11-03", commit: "d7fa65c" };

describe("historyEntry", () => {
  it("captures the set's identity, prompt hash and report metrics", () => {
    expect(historyEntry(setWith("Only about Alberto."), run)).toEqual({
      date: "2026-11-03",
      commit: "d7fa65c",
      provider: "lmstudio",
      model: "qwen/qwen3.5-9b",
      promptHash: "a".repeat(64),
      metrics: cleanMetrics,
    });
  });
});

describe("appendHistory and parseHistory", () => {
  const first = historyEntry(setWith("Only about Alberto."), run);
  const second = historyEntry(setWith("Madrid."), { date: "2026-11-04", commit: "e1f2a3b" });

  it("appends one JSON line per entry, and parses them back in order", () => {
    const once = appendHistory("", [first]);
    const twice = appendHistory(once, [second]);

    expect(once).toBe(`${JSON.stringify(first)}\n`);
    expect(twice.split("\n")).toHaveLength(3);
    expect(parseHistory(twice)).toEqual([first, second]);
  });

  it("adds a missing final newline before appending", () => {
    const text = JSON.stringify(first);

    expect(appendHistory(text, [second])).toBe(`${text}\n${JSON.stringify(second)}\n`);
  });

  it("appends nothing for no entries", () => {
    expect(appendHistory("", [])).toBe("");
  });

  it("parses an empty file as no history and ignores blank lines", () => {
    expect(parseHistory("")).toEqual([]);
    expect(parseHistory(`\n${JSON.stringify(first)}\n\n`)).toEqual([first]);
  });

  it("names the line of a malformed entry", () => {
    const bad = `${JSON.stringify(first)}\n{"date": "2026-11-04"}\n`;

    expect(() => parseHistory(bad)).toThrow(/history\.jsonl line 2/);
    expect(() => parseHistory("not json\n")).toThrow(/history\.jsonl line 1/);
  });
});

describe("checkHistory", () => {
  const clean = setWith("Only about Alberto.");
  const entry = historyEntry(clean, run);

  it("passes when each set's latest entry matches its recordings", () => {
    const older = historyEntry(setWith("Madrid."), { date: "2026-11-01", commit: "0000000" });

    expect(checkHistory([older, entry], [clean])).toEqual([]);
  });

  it("only compares entries of the same provider and model", () => {
    const other = { ...entry, provider: "anthropic", model: "claude-opus-5-5", promptHash: "b" };

    expect(checkHistory([entry, other], [clean])).toEqual([]);
  });

  it("fails when a recording set has no history entry", () => {
    expect(checkHistory([], [clean])).toEqual([
      "lmstudio/qwen/qwen3.5-9b has no entry in agent/evals/history.jsonl: re-record with `pnpm agent:eval`",
    ]);
  });

  it("fails when the latest entry was made with another prompt", () => {
    const problems = checkHistory([{ ...entry, promptHash: "b".repeat(64) }], [clean]);

    expect(problems).toEqual([
      "lmstudio/qwen/qwen3.5-9b: latest history entry doesn't match the recordings (promptHash): re-record with `pnpm agent:eval`",
    ]);
  });

  it("fails when the recordings changed without a new history line", () => {
    const leaky = setWith("Madrid.");

    expect(checkHistory([entry], [leaky])).toEqual([
      "lmstudio/qwen/qwen3.5-9b: latest history entry doesn't match the recordings (offTopicLeaks): re-record with `pnpm agent:eval`",
    ]);
  });
});

describe("renderHistory", () => {
  function entry(date: string, metrics: Partial<Metrics>, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    return {
      date,
      commit: "abc1234",
      provider: "lmstudio",
      model: "qwen/qwen3.5-9b",
      promptHash: "a".repeat(64),
      metrics: {
        cases: 30,
        offTopicLeaks: { n: 1, of: 17 },
        toolAccuracy: { n: 9, of: 9 },
        factCoverage: { n: 16, of: 18 },
        unknownHandling: { n: 0, of: 0 },
        meanInputTokens: 3000,
        meanOutputTokens: 170,
        meanLatencyMs: 4500,
        ...metrics,
      },
      ...overrides,
    };
  }

  it("renders each set's runs newest first, with the change from the run before", () => {
    const history = [
      entry("2026-11-03", {}),
      entry("2026-11-03", { cases: 1 }, { provider: "anthropic", model: "claude-opus-5-5" }),
      entry(
        "2026-11-04",
        {
          offTopicLeaks: { n: 0, of: 17 },
          factCoverage: { n: 17, of: 18 },
          meanInputTokens: 2958,
          meanOutputTokens: 170,
          meanLatencyMs: 4449,
        },
        { commit: "e1f2a3b", promptHash: "b".repeat(64) },
      ),
    ];

    expect(renderHistory(history)).toBe(`## History

Last 10 live runs per recording set, newest first, from \`agent/evals/history.jsonl\`. Changes are against the previous run of the same set; pp is percentage points.

### anthropic / claude-opus-5-5

| Date | Commit | Prompt | Cases | Leak rate | Tool accuracy | Fact coverage | Unknown handling | Input tokens | Output tokens | Latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-03 | \`abc1234\` | \`aaaaaaaaaaaa\` | 1 | 5.9% | 100.0% | 88.9% | n/a | 3000 | 170 | 4500 ms |

### lmstudio / qwen/qwen3.5-9b

| Date | Commit | Prompt | Cases | Leak rate | Tool accuracy | Fact coverage | Unknown handling | Input tokens | Output tokens | Latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-04 | \`e1f2a3b\` | \`bbbbbbbbbbbb\` | 30 | 0.0% (-5.9 pp) | 100.0% (±0.0 pp) | 94.4% (+5.6 pp) | n/a | 2958 (-42) | 170 (±0) | 4449 ms (-51) |
| 2026-11-03 | \`abc1234\` | \`aaaaaaaaaaaa\` | 30 | 5.9% | 100.0% | 88.9% | n/a | 3000 | 170 | 4500 ms |
`);
  });

  it("shows only the last 10 runs, still comparing the oldest shown with the one before it", () => {
    const history = Array.from({ length: 12 }, (_, i) =>
      entry(`2026-11-${String(i + 1).padStart(2, "0")}`, { meanInputTokens: 1000 + i }),
    );

    const rows = renderHistory(history)
      .split("\n")
      .filter((l) => l.startsWith("| 2026"));

    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatch(/^\| 2026-11-12 /);
    expect(rows[9]).toMatch(/^\| 2026-11-03 .*\| 1002 \(\+1\) \|/);
  });

  it("renders nothing without history", () => {
    expect(renderHistory([])).toBe("");
  });
});
