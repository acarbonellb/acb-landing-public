// Runs eval cases through the real chat agent and toolset. Only the model is
// swapped: a recording client around the real one (live), or a replay client
// over the committed recording (CI). Nothing in the agent knows it's an eval.
// Run limits are the loop's defaults, never the machine's env.
import { createHash } from "node:crypto";
import { createChatAgent, type ChatMessage } from "../chat";
import type { ModelClient, Usage } from "../model";
import { addUsage } from "../pricing";
import { systemPrompt } from "../system-prompt";
import { createToolset } from "../tools";
import { evalContent } from "./content";
import {
  canonicalJson,
  createRecordingModelClient,
  createReplayModelClient,
  StaleRecordingError,
  type RecordedCall,
} from "./recording";
import { byString, caseName, setLabel, type SetId } from "./format";
import { checkHistory, rescoreHistory, type HistoryEntry, type LiveRun } from "./history";
import type { CaseResult, SetResult } from "./metrics";
import { renderHistory, renderReport } from "./report";
import { scoreCase, type CaseResponse, type EvalCase } from "./scoring";

/** One case's committed recording (`recordings/<provider>/<model>/<id>-<slug>.json`). */
export type Recording = SetId & {
  caseId: string;
  slug: string;
  /** SHA-256 of the system prompt it was recorded with, for the report. */
  promptHash: string;
  calls: RecordedCall[];
};

export type RunOptions = {
  /** Defaults to the shipped system prompt. */
  system?: string;
};

/** The live run ended in an error: nothing may be written for it. */
export class RecordingFailedError extends Error {}

export function promptHash(system: string): string {
  return createHash("sha256").update(system).digest("hex");
}

function conversation(evalCase: EvalCase): ChatMessage[] {
  return [...(evalCase.priorTurns ?? []), { role: "user", content: evalCase.question }];
}

async function runChatCase(evalCase: EvalCase, model: ModelClient, { system }: RunOptions) {
  const response: CaseResponse = { answer: "", toolCalls: [] };
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const agent = createChatAgent({ model, toolset: createToolset(evalContent), system });
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
    promptHash: promptHash(options.system ?? systemPrompt),
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

/**
 * SHA-256 of a set's recordings: their content in case order, so neither the
 * order they're listed in nor JSON key order matters. What the eval history
 * checks recordings by, whatever their scores.
 */
export function recordingsFingerprint(recordings: Recording[]): string {
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
      promptHash: set.recordings[0]?.promptHash ?? promptHash(options.system ?? systemPrompt),
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
 * What `pnpm agent:eval:replay` runs: `replaySets`, then the report. Given a
 * `history`, it also fails on a set whose latest entry doesn't match its
 * recordings, and adds the history to the report.
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
}> {
  const { sets, problems } = await replaySets(input);
  if (history) problems.push(...checkHistory(history, sets));
  const historySection = history?.length ? `\n${renderHistory(history)}` : "";
  return { sets, problems, report: renderReport(sets) + historySection };
}
