// Runs eval cases through the real chat agent and toolset. Only the model is
// swapped: a recording client around the real one (live), or a replay client
// over the committed recording (CI). Nothing in the agent knows it's an eval.
// Run limits are the loop's defaults, never the machine's env.
import { createHash } from "node:crypto";
import { anthropicRequestParams } from "../anthropic";
import { createChatAgent, modelTools, type ChatMessage } from "../chat";
import { loadConfig } from "../config";
import type { Effort, ModelClient, Usage } from "../model";
import { addUsage } from "../pricing";
import { systemPrompt } from "../system-prompt";
import { createToolset, type Toolset } from "../tools";
import { evalContent } from "./content";
import {
  canonicalJson,
  createRecordingModelClient,
  createReplayModelClient,
  requestIdentity,
  StaleRecordingError,
  type RecordedCall,
} from "./recording";
import { byString, caseName, setLabel, type SetId } from "./format";
import { checkHistory, rescoreHistory, type HistoryEntry, type LiveRun } from "./history";
import type { CaseResult, ModelSettings, SetResult } from "./metrics";
import { renderHistory, renderReport } from "./report";
import { scoreCase, type CaseResponse, type EvalCase } from "./scoring";
import { renderSummaryJson } from "./summary";

/** One case's committed recording (`recordings/<provider>/<model>/<id>-<slug>.json`). */
export type Recording = SetId & {
  caseId: string;
  slug: string;
  /** The request identity (system prompt and tools) it was recorded with. */
  requestIdentity: string;
  /** The model settings it was recorded with (`modelSettings`). */
  settings: ModelSettings;
  calls: RecordedCall[];
};

export type RunOptions = {
  /** Defaults to the shipped system prompt. */
  system?: string;
  /** Defaults to the shipped tools over the eval content. */
  toolset?: Toolset;
  /**
   * The effort the model client was made with; defaults to the agent's (its
   * config schema's default), what replay expects every recording to state.
   */
  effort?: Effort;
};

/** The live run ended in an error: nothing may be written for it. */
export class RecordingFailedError extends Error {}

const evalToolset = (options: RunOptions) => options.toolset ?? createToolset(evalContent);

/**
 * What a recording of `model` states it was made with: the effort and the
 * parameters the model client adds to every request (`anthropicRequestParams`,
 * the one adapter the agent and the evals use). Not in the request hash: the
 * client adds them below the seam.
 */
export function modelSettings(model: string, effort: Effort): ModelSettings {
  return { effort, requestParams: anthropicRequestParams({ model, effort }) };
}

const agentEffort = (options: RunOptions) => options.effort ?? loadConfig({}).effort;

/** The request identity the agent asks with now (`requestIdentity`). */
export function currentRequestIdentity(options: RunOptions = {}): string {
  return requestIdentity(options.system ?? systemPrompt, modelTools(evalToolset(options)));
}

function conversation(evalCase: EvalCase): ChatMessage[] {
  return [...(evalCase.priorTurns ?? []), { role: "user", content: evalCase.question }];
}

async function runChatCase(evalCase: EvalCase, model: ModelClient, options: RunOptions) {
  const response: CaseResponse = { answer: "", toolCalls: [] };
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const agent = createChatAgent({ model, toolset: evalToolset(options), system: options.system });
  for await (const event of agent.run(conversation(evalCase))) {
    if (event.type === "text") response.answer += event.delta;
    else if (event.type === "tool_call") response.toolCalls.push(event.name);
    else if (event.type === "usage") addUsage(usage, event);
    else if (event.type === "done") response.stopReason = event.stopReason;
    else if (event.type === "error") response.error = event.code;
  }
  response.answer = response.answer.trim();
  return { response, usage };
}

function scoredResult(
  evalCase: EvalCase,
  { response, usage }: Awaited<ReturnType<typeof runChatCase>>,
  calls: RecordedCall[],
): CaseResult {
  return {
    evalCase,
    response,
    score: scoreCase(evalCase, response),
    usage,
    latencyMs: calls.reduce((sum, c) => sum + c.latencyMs, 0),
  };
}

/** Live: runs the case against `model` and returns its recording. */
export async function recordCase(
  evalCase: EvalCase,
  model: ModelClient,
  meta: SetId,
  options: RunOptions = {},
): Promise<{ recording: Recording; result: CaseResult }> {
  const recorder = createRecordingModelClient(model);
  const ran = await runChatCase(evalCase, recorder, options);
  if (ran.response.error) {
    throw new RecordingFailedError(
      `${caseName(evalCase)}: chat ended in error "${ran.response.error}"`,
    );
  }
  const recording: Recording = {
    caseId: evalCase.id,
    slug: evalCase.slug,
    ...meta,
    requestIdentity: currentRequestIdentity(options),
    settings: modelSettings(meta.model, agentEffort(options)),
    calls: recorder.calls,
  };
  return { recording, result: scoredResult(evalCase, ran, recorder.calls) };
}

/** Replay: the same run fed from `recording`; throws `StaleRecordingError`. */
export async function replayCase(
  evalCase: EvalCase,
  recording: Recording | undefined,
  options: RunOptions = {},
): Promise<CaseResult> {
  // Known before running: skip the loop (and its error log) altogether.
  if (!recording) throw new StaleRecordingError("missing_recording", 1);
  const replay = createReplayModelClient(recording.calls);
  const ran = await runChatCase(evalCase, replay, options);
  if (replay.staleError) throw replay.staleError;
  return scoredResult(evalCase, ran, recording.calls);
}

export type RecordingSet = SetId & { recordings: Recording[] };

/** The settings every recording states; `undefined` when they differ (or there are none). */
function sharedSettings(recordings: Recording[]): ModelSettings | undefined {
  const all = new Set(recordings.map((r) => canonicalJson(r.settings)));
  return all.size === 1 ? recordings[0].settings : undefined;
}

/**
 * SHA-256 of a set's recordings: their content in case order, so neither the
 * order they're listed in nor JSON key order matters. What the eval history
 * checks recordings by, whatever their scores.
 */
export function recordingsFingerprint(recordings: { caseId: string }[]): string {
  const ordered = [...recordings].sort((a, b) => byString(a.caseId, b.caseId));
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}

/**
 * Replays every case of every recording set: what both a live run (for its
 * history line) and `evaluate` start from. `problems` are stale or missing
 * recordings, leaks (off_topic, mixed, injection) and a failed gated case (the
 * contact question, ADR 0001). Tool accuracy and fact coverage are only
 * reported.
 */
export async function replaySets({
  cases,
  sets,
  ...options
}: { cases: EvalCase[]; sets: RecordingSet[] } & RunOptions): Promise<{
  sets: SetResult[];
  problems: string[];
}> {
  const problems: string[] = [];
  const results: SetResult[] = [];
  for (const set of sets) {
    const label = setLabel(set);
    const identity = currentRequestIdentity(options);
    const otherIdentity = set.recordings.filter((r) => r.requestIdentity !== identity).length;
    if (otherIdentity) {
      problems.push(
        `${label}: ${otherIdentity} recording${otherIdentity === 1 ? " was" : "s were"} made with another request identity (the system prompt or the tools changed): re-record with \`pnpm agent:eval\``,
      );
    }
    const settings = canonicalJson(modelSettings(set.model, agentEffort(options)));
    const otherSettings = set.recordings.filter((r) => canonicalJson(r.settings) !== settings);
    if (otherSettings.length) {
      const which =
        otherSettings.length === set.recordings.length && set.recordings.length > 1
          ? `all ${set.recordings.length} recordings`
          : otherSettings.map((r) => caseName({ id: r.caseId, slug: r.slug })).join(", ");
      problems.push(
        `${label}: recorded with other model settings than the agent's (${which}): re-record with \`pnpm agent:eval\``,
      );
    }
    const byCase = new Map(set.recordings.map((r) => [r.caseId, r]));
    const setResults: CaseResult[] = [];
    for (const evalCase of cases) {
      const name = `${label} ${caseName(evalCase)}`;
      try {
        const result = await replayCase(evalCase, byCase.get(evalCase.id), options);
        setResults.push(result);
        if (result.score.leaked) problems.push(`${name} leaked: ${result.score.reasons.join("; ")}`);
        if (evalCase.kind === "on_topic" && evalCase.gated && !result.score.pass) {
          problems.push(`${name} failed a gated case: ${result.score.reasons.join("; ")}`);
        }
      } catch (error) {
        problems.push(`${name}: ${(error as Error).message}`);
      }
    }
    results.push({
      provider: set.provider,
      model: set.model,
      requestIdentity: identity,
      settings: sharedSettings(set.recordings),
      fingerprint: recordingsFingerprint(set.recordings),
      results: setResults,
    });
  }
  return { sets: results, problems };
}

/**
 * What `pnpm agent:eval:rescore` runs: the stored recordings replayed and
 * scored by the current cases, and the `rescored` history entries that makes
 * (see `rescoreHistory`). Replay only: no model is ever called.
 */
export async function rescore({
  history,
  run,
  note,
  ...input
}: {
  cases: EvalCase[];
  sets: RecordingSet[];
  history: HistoryEntry[];
  run: LiveRun;
  /** What the scoring change is; needed when scores changed (see `rescoreHistory`). */
  note?: string;
} & RunOptions): Promise<{ entries: HistoryEntry[]; problems: string[] }> {
  const { sets } = await replaySets(input);
  return rescoreHistory(history, sets, input.cases.length, run, note);
}

/**
 * What `pnpm agent:eval:replay` runs: `replaySets`, then the report and the
 * summary (`summary.json`). Given a `history`, it also fails on a set whose
 * latest entry doesn't match its recordings, and adds the history to the
 * report. The summary is made from the replayed recordings alone.
 */
export async function evaluate({
  history,
  ...input
}: {
  cases: EvalCase[];
  sets: RecordingSet[];
  /** The parsed `history.jsonl`; checked and rendered when given. */
  history?: HistoryEntry[];
} & RunOptions): Promise<{
  sets: SetResult[];
  problems: string[];
  report: string;
  summary: string;
}> {
  const { sets, problems } = await replaySets(input);
  if (history) problems.push(...checkHistory(history, sets));
  const historySection = history?.length ? `\n${renderHistory(history)}` : "";
  return {
    sets,
    problems,
    report: renderReport(sets) + historySection,
    summary: renderSummaryJson(sets),
  };
}

/** The files `evaluate` generates, as text. */
export type GeneratedFiles = { report: string; summary: string };

const generatedPaths: Record<keyof GeneratedFiles, string> = {
  report: "agent/evals/report.md",
  summary: "agent/evals/summary.json",
};

/**
 * `--check`'s comparison: one problem per committed file (`undefined` when
 * missing) that differs from the one just generated.
 */
export function staleFiles(
  generated: GeneratedFiles,
  committed: Record<keyof GeneratedFiles, string | undefined>,
): string[] {
  return (Object.keys(generatedPaths) as (keyof GeneratedFiles)[]).flatMap((file) =>
    committed[file] === generated[file]
      ? []
      : [`${generatedPaths[file]} differs from the recordings: run \`pnpm agent:eval:replay\` and commit it`],
  );
}
