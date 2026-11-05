import { describe, expect, it } from "vitest";
import {
  appendHistory,
  appendLiveRun,
  checkHistory,
  historyEntry,
  liveRunKind,
  parseHistory,
  rescoreHistory,
  type HistoryEntry,
} from "./history";
import type { Metrics, SetResult } from "./metrics";
import { renderHistory } from "./report";
import { scoreCase, type CaseResponse, type EvalCase } from "./scoring";

const capital: EvalCase = {
  id: "ot01",
  slug: "capital",
  kind: "off_topic",
  question: "Capital?",
  forbidden: [/\bmadrid\b/i],
};

function setWith(answer: string, overrides: Partial<SetResult> = {}): SetResult {
  const response: CaseResponse = { answer, toolCalls: [], stopReason: "end_turn" };
  return {
    provider: "lmstudio",
    model: "qwen/qwen3.5-9b",
    requestIdentity: "a".repeat(64),
    fingerprint: "f".repeat(64),
    results: [
      {
        evalCase: capital,
        response,
        score: scoreCase(capital, response),
        usage: { inputTokens: 1000, outputTokens: 100 },
        latencyMs: 2000,
      },
    ],
    ...overrides,
  };
}

const cleanMetrics: Metrics = {
  cases: 1,
  leaks: { n: 0, of: 1 },
  toolAccuracy: { n: 0, of: 0 },
  factCoverage: { n: 0, of: 0 },
  unknownHandling: { n: 0, of: 0 },
  meanInputTokens: 1000,
  meanOutputTokens: 100,
  meanLatencyMs: 2000,
  meanCostUsd: 0,
  passAtK: { k: 1, n: 1, of: 1 },
  flaky: { n: 0, of: 1 },
};

const run = { date: "2026-11-03", commit: "d7fa65c" };

/** Metrics as an entry from before costs were recorded holds them. */
function withoutCost(metrics: Metrics): Metrics {
  const copy = { ...metrics };
  delete copy.meanCostUsd;
  return copy;
}

/** An entry as one made before `keys` were recorded holds it. */
function without(
  entry: HistoryEntry,
  ...keys: ("kind" | "fingerprint" | "requestIdentity")[]
): HistoryEntry {
  const copy = { ...entry };
  for (const key of keys) delete copy[key];
  return copy;
}

describe("historyEntry", () => {
  it("captures the set's identity, request identity, recordings fingerprint, kind and report metrics", () => {
    expect(historyEntry(setWith("Only about Alberto."), run, "live")).toEqual({
      date: "2026-11-03",
      commit: "d7fa65c",
      kind: "live",
      provider: "lmstudio",
      model: "qwen/qwen3.5-9b",
      requestIdentity: "a".repeat(64),
      fingerprint: "f".repeat(64),
      metrics: cleanMetrics,
    });
  });
});

describe("appendHistory and parseHistory", () => {
  const first = historyEntry(setWith("Only about Alberto."), run, "live");
  const second = historyEntry(setWith("Madrid."), { date: "2026-11-04", commit: "e1f2a3b" }, "rescored");

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

  it("parses an entry from before kinds and fingerprints were recorded", () => {
    const older = without(first, "kind", "fingerprint");

    expect(parseHistory(`${JSON.stringify(older)}\n`)).toEqual([older]);
  });

  it("parses an entry from before the request identity covered the tools", () => {
    const older = { ...without(first, "requestIdentity"), promptHash: "c".repeat(64) };

    expect(parseHistory(`${JSON.stringify(older)}\n`)).toEqual([older]);
  });

  it("rejects an entry with neither a request identity nor a prompt hash", () => {
    expect(() => parseHistory(`${JSON.stringify(without(first, "requestIdentity"))}\n`)).toThrow(
      /history\.jsonl line 1: .*needs a requestIdentity/,
    );
  });

  it("parses a re-scored entry's note", () => {
    const noted = { ...historyEntry(setWith("Only about Alberto."), run, "rescored"), note: "stricter decline" };
    expect(parseHistory(appendHistory("", [noted]))).toEqual([noted]);
  });

  it("rejects an unknown kind", () => {
    expect(() => parseHistory(`${JSON.stringify({ ...first, kind: "replay" })}\n`)).toThrow(
      /history\.jsonl line 1/,
    );
  });

  it("parses an entry from before costs were recorded", () => {
    const uncosted = withoutCost(first.metrics);
    const older = { ...first, metrics: uncosted };

    expect(parseHistory(`${JSON.stringify(older)}\n`)).toEqual([older]);
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

describe("appendLiveRun", () => {
  const complete = setWith("Only about Alberto.");

  it("appends exactly one entry for the recorded set", () => {
    const earlier = appendHistory("", [
      historyEntry(complete, { date: "2026-11-01", commit: "0000000" }, "live"),
    ]);

    const text = appendLiveRun(earlier, complete, 1, run, "live");

    expect(parseHistory(text!)).toEqual([...parseHistory(earlier), historyEntry(complete, run, "live")]);
  });

  it("appends nothing while some of the set's cases can't be replayed", () => {
    expect(appendLiveRun("", complete, 2, run, "live")).toBeUndefined();
    expect(appendLiveRun("", undefined, 1, run, "live")).toBeUndefined();
  });
});

describe("liveRunKind (the re-run guard)", () => {
  const set = setWith("Only about Alberto.");
  const at = (commit: string, kind?: HistoryEntry["kind"]) => {
    const entry = historyEntry(set, { date: "2026-11-03", commit }, kind ?? "live");
    if (!kind) delete entry.kind;
    return entry;
  };
  const refused = {
    refused:
      "lmstudio / qwen/qwen3.5-9b already has a live run at commit d7fa65c: commit a change first, or pass --rerun to record a re-run",
  };

  it("is a live run at a commit with no live run of the set", () => {
    expect(liveRunKind([at("0000000")], set, "d7fa65c", false)).toEqual({ kind: "live" });
  });

  it("refuses a second live run at the same commit without --rerun", () => {
    expect(liveRunKind([at("d7fa65c", "live")], set, "d7fa65c", false)).toEqual(refused);
  });

  it("marks it a re-run with --rerun", () => {
    expect(liveRunKind([at("d7fa65c", "live")], set, "d7fa65c", true)).toEqual({ kind: "rerun" });
  });

  it("counts re-runs and entries from before kinds were recorded as live runs", () => {
    expect(liveRunKind([at("d7fa65c", "rerun")], set, "d7fa65c", false)).toEqual(refused);
    expect(liveRunKind([at("d7fa65c")], set, "d7fa65c", false)).toEqual(refused);
  });

  it("doesn't count a re-score or another set's live run", () => {
    const other = { ...at("d7fa65c", "live"), provider: "anthropic", model: "claude-haiku-5-5" };

    expect(liveRunKind([at("d7fa65c", "rescored"), other], set, "d7fa65c", false)).toEqual({
      kind: "live",
    });
  });

  it("is still a live run with --rerun when there is nothing to re-run", () => {
    expect(liveRunKind([], set, "d7fa65c", true)).toEqual({ kind: "live" });
  });
});

describe("checkHistory", () => {
  const clean = setWith("Only about Alberto.");
  const entry = historyEntry(clean, run, "live");
  const rerecord = "re-record with `pnpm agent:eval`";
  const rescore = "re-score with `pnpm agent:eval:rescore`";

  it("passes when each set's latest entry matches its recordings", () => {
    const older = historyEntry(setWith("Madrid.", { fingerprint: "0".repeat(64) }), {
      date: "2026-11-01",
      commit: "0000000",
    }, "live");

    expect(checkHistory([older, entry], [clean])).toEqual([]);
  });

  it("only compares entries of the same provider and model", () => {
    const other = { ...entry, provider: "anthropic", model: "claude-opus-5-5", fingerprint: "b" };

    expect(checkHistory([entry, other], [clean])).toEqual([]);
  });

  it("fails when a recording set has no history entry", () => {
    expect(checkHistory([], [clean])).toEqual([
      `lmstudio / qwen/qwen3.5-9b has no entry in agent/evals/history.jsonl: ${rerecord}`,
    ]);
  });

  it("fails when recordings are committed without their history line", () => {
    const rerecorded = setWith("Only about Alberto.", { fingerprint: "c".repeat(64) });

    expect(checkHistory([entry], [rerecorded])).toEqual([
      `lmstudio / qwen/qwen3.5-9b: latest history entry doesn't match the recordings (fingerprint): ${rerecord}`,
    ]);
  });

  it("fails when a history line is committed without its recordings", () => {
    const newer = { ...entry, commit: "e1f2a3b", fingerprint: "c".repeat(64) };

    expect(checkHistory([entry, newer], [clean])).toEqual([
      `lmstudio / qwen/qwen3.5-9b: latest history entry doesn't match the recordings (fingerprint): ${rerecord}`,
    ]);
  });

  it("fails when the latest entry was made with another request identity", () => {
    const problems = checkHistory([{ ...entry, requestIdentity: "b".repeat(64) }], [clean]);

    expect(problems).toEqual([
      `lmstudio / qwen/qwen3.5-9b: latest history entry doesn't match the recordings (requestIdentity): ${rerecord}`,
    ]);
  });

  it("asks for the migration when the latest entry has only a system prompt hash", () => {
    const older = { ...without(entry, "requestIdentity"), promptHash: "a".repeat(64) };

    expect(checkHistory([older], [clean])).toEqual([
      "lmstudio / qwen/qwen3.5-9b: latest history entry has no request identity, only a system prompt hash: migrate it with `pnpm --filter agent exec tsx scripts/migrate-request-identity.ts` (ADR 0001, #98)",
    ]);
  });

  it("asks for a re-score, not a live run, when the same recordings now score differently", () => {
    const rescored = setWith("Madrid.");

    expect(checkHistory([entry], [rescored])).toEqual([
      `lmstudio / qwen/qwen3.5-9b: latest history entry was scored differently (leaks, passAtK): ${rescore}`,
    ]);
  });

  it("asks for a re-score when the latest entry has no fingerprint, from before fingerprints were recorded", () => {
    const legacy = without(entry, "fingerprint");

    expect(checkHistory([legacy], [clean])).toEqual([
      `lmstudio / qwen/qwen3.5-9b: latest history entry has no recordings fingerprint: ${rescore}`,
    ]);
  });
});

describe("rescoreHistory", () => {
  const clean = setWith("Only about Alberto.");
  const live = historyEntry(clean, run, "live");
  const today = { date: "2026-11-06", commit: "e1f2a3b" };
  // The same recordings, scored by a stricter case: the answer now leaks.
  const stricter = setWith("Only about Alberto.", {});
  stricter.results = stricter.results.map((r) => {
    const evalCase = { ...r.evalCase, forbidden: [/\balberto\b/i] };
    return { ...r, evalCase, score: scoreCase(evalCase, r.response) };
  });

  const note = "stricter leak check";

  it("appends a re-scored entry with the current scores of the same recordings, and the note on the change", () => {
    const rescored = { ...historyEntry(stricter, today, "rescored"), note };

    expect(rescoreHistory([live], [stricter], 1, today, note)).toEqual({
      entries: [rescored],
      problems: [],
    });
    expect(checkHistory([live, rescored], [stricter])).toEqual([]);
  });

  it("refuses scores that changed without a note on the scoring change", () => {
    expect(rescoreHistory([live], [stricter], 1, today)).toEqual({
      entries: [],
      problems: [
        'lmstudio / qwen/qwen3.5-9b: scores changed with the same recordings: say what the scoring change is with `pnpm agent:eval:rescore --note "..."`',
      ],
    });
  });

  it("with a note, appends an entry for every set, also one whose scores didn't change", () => {
    const other = setWith("Only about Alberto.", { provider: "anthropic", model: "claude-haiku-5-5" });
    const otherLive = historyEntry(other, run, "live");

    expect(rescoreHistory([live, otherLive], [stricter, other], 1, today, note).entries).toEqual([
      { ...historyEntry(stricter, today, "rescored"), note },
      { ...historyEntry(other, today, "rescored"), note },
    ]);
  });

  it("adds the fingerprint to an entry from before fingerprints, while it still matches its recordings", () => {
    const legacy = without(live, "fingerprint");

    expect(rescoreHistory([legacy], [clean], 1, today)).toEqual({
      entries: [historyEntry(clean, today, "rescored")],
      problems: [],
    });
  });

  it("appends nothing for a set whose latest entry already matches", () => {
    expect(rescoreHistory([live], [clean], 1, today)).toEqual({ entries: [], problems: [] });
  });

  it("refuses recordings that changed since the latest entry: only a live run records them", () => {
    const rerecorded = setWith("Only about Alberto.", { fingerprint: "c".repeat(64) });
    const legacy = without(live, "fingerprint");

    expect(rescoreHistory([live], [rerecorded], 1, today)).toEqual({
      entries: [],
      problems: [
        "lmstudio / qwen/qwen3.5-9b: recordings changed since the latest history entry, not re-scored: re-record with `pnpm agent:eval`",
      ],
    });
    expect(rescoreHistory([legacy], [stricter], 1, today).problems).toEqual([
      "lmstudio / qwen/qwen3.5-9b: recordings changed since the latest history entry, not re-scored: re-record with `pnpm agent:eval`",
    ]);
  });

  it("refuses a set with no history entry, or with cases that can't be replayed", () => {
    expect(rescoreHistory([], [clean], 1, today).problems).toEqual([
      "lmstudio / qwen/qwen3.5-9b has no entry in agent/evals/history.jsonl: re-record with `pnpm agent:eval`",
    ]);
    expect(rescoreHistory([live], [stricter], 2, today).problems).toEqual([
      "lmstudio / qwen/qwen3.5-9b: some recordings are stale or missing, not re-scored: re-record with `pnpm agent:eval`",
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
      requestIdentity: "a".repeat(64),
      metrics: {
        cases: 30,
        leaks: { n: 1, of: 17 },
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

  it("renders each set's entries newest first, with their kind and the change from the entry before", () => {
    const history = [
      // From before kinds were recorded (a live run) and before the request
      // identity covered the tools (a hash of the system prompt alone).
      without(entry("2026-11-03", {}, { promptHash: "c".repeat(64) }), "requestIdentity"),
      entry(
        "2026-11-03",
        { cases: 1, meanCostUsd: 0.000362 },
        { provider: "anthropic", model: "claude-opus-5-5", kind: "rescored" },
      ),
      entry(
        "2026-11-04",
        {
          leaks: { n: 0, of: 17 },
          factCoverage: { n: 17, of: 18 },
          meanInputTokens: 2958,
          meanOutputTokens: 170,
          meanLatencyMs: 4449,
          meanCostUsd: 0,
        },
        { commit: "e1f2a3b", requestIdentity: "b".repeat(64), kind: "rerun" },
      ),
      entry(
        "2026-11-05",
        { meanCostUsd: 0, passAtK: { k: 1, n: 28, of: 30 }, flaky: { n: 0, of: 30 } },
        { commit: "f4e5d6c", kind: "rescored", note: "stricter decline scorer (#99)" },
      ),
    ];

    expect(renderHistory(history)).toBe(`## History

Last 10 entries per recording set, newest first, from \`agent/evals/history.jsonl\`. Kind is \`live\` for a live run, \`rerun\` for a second live run at the same commit, \`rescored\` for the stored recordings scored again with no model call, with a note on the scoring change, and \`migrated\` for the stored recordings rewritten to a new format by a script, with the same scores and no model call. Request identity is a hash of the system prompt and the tools; older entries hold a hash of the system prompt alone, marked "prompt only". Changes are against the previous entry of the same set; pp is percentage points.

### anthropic / claude-opus-5-5

| Date | Commit | Kind | Request identity | Cases | Leak rate | Tool accuracy | Fact coverage | Unknown handling | pass@k | Flaky | Input tokens | Output tokens | Latency | Cost per case |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-03 | \`abc1234\` | rescored | \`aaaaaaaaaaaa\` | 1 | 5.9% | 100.0% | 88.9% | n/a | n/a | n/a | 3000 | 170 | 4500 ms | $0.000362 |

### lmstudio / qwen/qwen3.5-9b

| Date | Commit | Kind | Request identity | Cases | Leak rate | Tool accuracy | Fact coverage | Unknown handling | pass@k | Flaky | Input tokens | Output tokens | Latency | Cost per case |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-05 | \`f4e5d6c\` | rescored | \`aaaaaaaaaaaa\` | 30 | 5.9% (+5.9 pp) | 100.0% (±0.0 pp) | 88.9% (-5.6 pp) | n/a | pass@1 93.3% | 0 | 3000 (+42) | 170 (±0) | 4500 ms (+51) | $0 |
| 2026-11-04 | \`e1f2a3b\` | rerun | \`bbbbbbbbbbbb\` | 30 | 0.0% (-5.9 pp) | 100.0% (±0.0 pp) | 94.4% (+5.6 pp) | n/a | n/a | n/a | 2958 (-42) | 170 (±0) | 4449 ms (-51) | $0 |
| 2026-11-03 | \`abc1234\` | live | \`cccccccccccc\` (prompt only) | 30 | 5.9% | 100.0% | 88.9% | n/a | n/a | n/a | 3000 | 170 | 4500 ms | n/a |

Notes:

- 2026-11-05 \`f4e5d6c\` rescored: stricter decline scorer (#99)
`);
  });

  it("compares pass@k only with an entry of the same k, and counts flaky cases", () => {
    const history = [
      entry("2026-11-05", { passAtK: { k: 1, n: 30, of: 30 }, flaky: { n: 0, of: 30 } }),
      entry("2026-11-06", { passAtK: { k: 3, n: 27, of: 30 }, flaky: { n: 2, of: 30 } }, { commit: "f4e5d6c" }),
      entry("2026-11-07", { passAtK: { k: 3, n: 28, of: 30 }, flaky: { n: 1, of: 30 } }, { commit: "a1b2c3d" }),
    ];

    const rows = renderHistory(history)
      .split("\n")
      .filter((l) => l.startsWith("| 2026"));

    expect(rows[0]).toContain("| n/a | pass@3 93.3% (+3.3 pp) | 1 (-1) |");
    expect(rows[1]).toContain("| n/a | pass@3 90.0% | 2 (+2) |");
  });

  it("shows only the last 10 entries, still comparing the oldest shown with the one before it", () => {
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
