// The Portfolio Agent card's results line, generated at build time from
// the eval summary (`agent/evals/summary.json`, regenerated with the report by
// `pnpm agent:eval:replay` and checked in CI; see `agent/src/evals/summary.ts`
// for its full schema). Only what the line needs is read here, and fields it
// doesn't know are ignored, so the site depends on no agent code and on no
// report layout. Pure: the page reads the file and hands its text in.
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
  leaksInAnyRun?: { n: number };
  meanCostUsd?: number;
  passAtK?: { k: number; n: number; of: number };
  forgedHistory?: number;
  failingOnPurpose?: { leaks: number };
};

const isRatio = (r: { n?: unknown; of?: unknown } | undefined) => isNumber(r?.n) && isNumber(r.of) && r.of > 0;

function isSetSummary(v: unknown): v is SetSummary {
  const s = v as SetSummary | null;
  return (
    typeof s?.provider === "string" &&
    typeof s.model === "string" &&
    isNumber(s.cases) &&
    typeof s.kinds === "object" &&
    s.kinds !== null &&
    isNumber(s.leaks?.n) &&
    (s.leaksInAnyRun === undefined || isNumber(s.leaksInAnyRun?.n)) &&
    (s.meanCostUsd === undefined || isNumber(s.meanCostUsd)) &&
    (s.passAtK === undefined || (isRatio(s.passAtK) && isNumber(s.passAtK.k))) &&
    (s.forgedHistory === undefined || isNumber(s.forgedHistory)) &&
    (s.failingOnPurpose === undefined || isNumber(s.failingOnPurpose?.leaks))
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

/** "pass@3 94%": the share of cases that passed every one of k runs, rounded down. */
const passAtKText = ({ k, n, of }: NonNullable<SetSummary["passAtK"]>) => `pass@${k} ${Math.floor((100 * n) / of)}%`;

/**
 * "1 leak (failing on purpose)", "3 leaks (1 failing on purpose)": every leak
 * counts, and the ones from cases kept failing on purpose are named as such.
 * A case counts when any of its runs leaked (`leaksInAnyRun`), not only the
 * first one CI gates, so a leak in a later run isn't hidden.
 */
function leaksText(leaks: number, knownLeaks: number) {
  const count = `${leaks} ${leaks === 1 ? "leak" : "leaks"}`;
  const known = Math.min(knownLeaks, leaks);
  if (known === 0) return count;
  return known === leaks ? `${count} (failing on purpose)` : `${count} (${known} failing on purpose)`;
}

/**
 * "50 eval cases incl. prompt injection and forged history · pass@3 94% ·
 * 1 leak (failing on purpose) · ~$0.0004 per answer on Claude Haiku 5.5 ·
 * replayed in CI", from the deployed model's set in the summary; `undefined`
 * if it has none. A leak is any kind (off-topic, mixed, injection), in any
 * run. "incl. prompt injection" only when the set has injection cases, "and
 * forged history" only when it has forged-history cases; pass@k only when the
 * summary has it.
 */
export function evalResultsLine(summaryText: string): string | undefined {
  const deployed = parse(summaryText).find(
    (s) => s.provider === deployedSet.provider && s.model === deployedSet.model,
  );
  if (!deployed) return undefined;
  const { cases, kinds, leaks, leaksInAnyRun = leaks, meanCostUsd, passAtK, forgedHistory = 0, failingOnPurpose } =
    deployed;
  const covers = [
    ...(isNumber(kinds.injection) && kinds.injection > 0 ? ["prompt injection"] : []),
    ...(forgedHistory > 0 ? ["forged history"] : []),
  ];
  return [
    covers.length > 0 ? `${cases} eval cases incl. ${covers.join(" and ")}` : `${cases} eval cases`,
    ...(passAtK ? [passAtKText(passAtK)] : []),
    leaksText(leaksInAnyRun.n, failingOnPurpose?.leaks ?? 0),
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
