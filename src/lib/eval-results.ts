// The Portfolio Agent card's results line (#44), generated at build time from
// the eval summary (`agent/evals/summary.json`, regenerated with the report by
// `pnpm agent:eval:replay` and checked in CI; see `agent/src/evals/summary.ts`
// for its full schema). Only what the line needs is read here, and fields it
// doesn't know are ignored, so the site depends on no agent code and on no
// report layout (#101). Pure: the page reads the file and hands its text in.
import type { AgentProject } from "@/shared/profile";
import { isNumber } from "./is-number";

/**
 * The recording set of the model the deployed agent runs on: the agent's
 * default model (`agent/src/config.ts`; a test keeps them in step).
 */
export const deployedSet = {
  provider: "anthropic",
  model: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
};

const cardSlug = "portfolio-agent";
const summaryPath = "agent/evals/summary.json";

type SetSummary = {
  provider: string;
  model: string;
  cases: number;
  kinds: Record<string, unknown>;
  leaks: { n: number };
  meanCostUsd?: number;
};

function isSetSummary(v: unknown): v is SetSummary {
  const s = v as SetSummary | null;
  return (
    typeof s?.provider === "string" &&
    typeof s.model === "string" &&
    isNumber(s.cases) &&
    typeof s.kinds === "object" &&
    s.kinds !== null &&
    isNumber(s.leaks?.n) &&
    (s.meanCostUsd === undefined || isNumber(s.meanCostUsd))
  );
}

function parse(text: string): SetSummary[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${summaryPath}: not JSON`);
  }
  const sets = (json as { sets?: unknown } | null)?.sets;
  if (!Array.isArray(sets) || !sets.every(isSetSummary)) {
    throw new Error(`${summaryPath}: not an eval summary`);
  }
  return sets;
}

/** "0.0004": one significant digit, never in exponent notation. */
const roughUsd = (usd: number) => String(Number(usd.toPrecision(1)));

/**
 * "42 eval cases incl. prompt injection · 0 leaks · ~$0.0004 per answer on
 * Claude Haiku 5.5 · replayed in CI", from the deployed model's set in the
 * summary; `undefined` if it has none. A leak is any kind (off-topic, mixed,
 * injection); "incl. prompt injection" only when the set has injection cases.
 */
export function evalResultsLine(summaryText: string): string | undefined {
  const deployed = parse(summaryText).find(
    (s) => s.provider === deployedSet.provider && s.model === deployedSet.model,
  );
  if (!deployed) return undefined;
  const { cases, kinds, leaks, meanCostUsd } = deployed;
  return [
    isNumber(kinds.injection) && kinds.injection > 0
      ? `${cases} eval cases incl. prompt injection`
      : `${cases} eval cases`,
    `${leaks.n} ${leaks.n === 1 ? "leak" : "leaks"}`,
    meanCostUsd === undefined
      ? `on ${deployedSet.name}`
      : `~$${roughUsd(meanCostUsd)} per answer on ${deployedSet.name}`,
    "replayed in CI",
  ].join(" · ");
}

/** The agent projects, with the results line as the Portfolio Agent card's result. */
export function withEvalResults(agentProjects: AgentProject[], summaryText: string): AgentProject[] {
  const result = evalResultsLine(summaryText);
  if (!result) return agentProjects;
  return agentProjects.map((a) => (a.slug === cardSlug ? { ...a, result } : a));
}
