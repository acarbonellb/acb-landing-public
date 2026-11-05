// The Portfolio Agent card's results line (#44), generated at build time from
// the eval history (`agent/evals/history.jsonl`, written by `pnpm agent:eval`;
// see `agent/src/evals/history.ts` for its full schema). Only what the line
// needs is read here, so the site depends on no agent code. Pure: the page
// reads the file and hands its text in.
import type { AgentProject } from "@/content/profile";

/** The recording set of the model the deployed agent runs on. */
const deployedSet = {
  provider: "anthropic",
  model: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
};

const cardSlug = "portfolio-agent";

type Entry = {
  provider: string;
  model: string;
  metrics: { cases: number; leaks: { n: number; of: number }; meanCostUsd?: number };
};

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isEntry(v: unknown): v is Entry {
  const e = v as Entry | null;
  return (
    typeof e?.provider === "string" &&
    typeof e.model === "string" &&
    isNumber(e.metrics?.cases) &&
    isNumber(e.metrics.leaks?.n) &&
    (e.metrics.meanCostUsd === undefined || isNumber(e.metrics.meanCostUsd))
  );
}

function parse(text: string): Entry[] {
  return text.split("\n").flatMap((line, i) => {
    if (!line.trim()) return [];
    const where = `agent/evals/history.jsonl line ${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not JSON`);
    }
    if (!isEntry(json)) throw new Error(`${where}: not an eval history entry`);
    return [json];
  });
}

/** "0.0004": one significant digit, never in exponent notation. */
const roughUsd = (usd: number) => String(Number(usd.toPrecision(1)));

/**
 * "42 eval cases incl. prompt injection · 0 off-topic leaks · ~$0.0004 per
 * answer on Claude Haiku 5.5 · replayed in CI", from the latest run of the
 * deployed model; `undefined` if it has none.
 */
export function evalResultsLine(historyText: string): string | undefined {
  const latest = parse(historyText).findLast(
    (e) => e.provider === deployedSet.provider && e.model === deployedSet.model,
  );
  if (!latest) return undefined;
  const { cases, leaks, meanCostUsd } = latest.metrics;
  return [
    `${cases} eval cases incl. prompt injection`,
    `${leaks.n} off-topic ${leaks.n === 1 ? "leak" : "leaks"}`,
    meanCostUsd === undefined
      ? `on ${deployedSet.name}`
      : `~$${roughUsd(meanCostUsd)} per answer on ${deployedSet.name}`,
    "replayed in CI",
  ].join(" · ");
}

/** `agents` with the results line as the Portfolio Agent card's result. */
export function withEvalResults(agents: AgentProject[], historyText: string): AgentProject[] {
  const result = evalResultsLine(historyText);
  if (!result) return agents;
  return agents.map((a) => (a.slug === cardSlug ? { ...a, result } : a));
}
