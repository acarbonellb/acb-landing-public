// Runs eval cases through the real chat loop and toolset. Only the model is
// swapped: a recording client around the real one (live), or a replay client
// over the committed recording (CI). Nothing in the agent knows it's an eval.
// Run limits are the loop's defaults, never the machine's env.
import { createHash } from "node:crypto";
import { runChat, systemPrompt, type ChatMessage } from "../chat";
import type { ModelClient } from "../model";
import { createToolset } from "../tools";
import { evalContent } from "./content";
import {
  createRecordingModelClient,
  createReplayModelClient,
  StaleRecordingError,
  type RecordedCall,
} from "./recording";
import { caseName, setLabel, type SetId } from "./format";
import { checkHistory, renderHistory, type HistoryEntry } from "./history";
import { renderReport, type CaseResult, type SetResult } from "./report";
import { scoreCase, type CaseOutcome, type EvalCase } from "./scoring";

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
  const outcome: CaseOutcome = { answer: "", toolCalls: [] };
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const event of runChat({
    model,
    toolset: createToolset(evalContent),
    system,
    messages: conversation(evalCase),
  })) {
    if (event.type === "text") outcome.answer += event.delta;
    else if (event.type === "tool_call") outcome.toolCalls.push(event.name);
    else if (event.type === "usage") {
      usage.inputTokens += event.inputTokens;
      usage.outputTokens += event.outputTokens;
    } else if (event.type === "done") outcome.stopReason = event.stopReason;
    else if (event.type === "error") outcome.error = event.code;
  }
  outcome.answer = outcome.answer.trim();
  return { outcome, usage };
}

function scoredResult(
  evalCase: EvalCase,
  { outcome, usage }: Awaited<ReturnType<typeof runChatCase>>,
  calls: RecordedCall[],
): CaseResult {
  return {
    evalCase,
    outcome,
    score: scoreCase(evalCase, outcome),
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
  if (ran.outcome.error) {
    throw new RecordingFailedError(
      `${caseName(evalCase)}: chat ended in error "${ran.outcome.error}"`,
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
 * Replays every case of every recording set. `problems` are what fails CI:
 * stale or missing recordings, leaks (off_topic, mixed, injection), a failed
 * gated case (the contact question, ADR 0001) and, given
 * a `history`, a set whose latest entry doesn't match its recordings. Tool
 * accuracy and fact coverage are only reported.
 */
export async function evaluate({
  cases,
  sets,
  history,
  ...options
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
      results: setResults,
    });
  }
  if (history) problems.push(...checkHistory(history, results));
  const historySection = history?.length ? `\n${renderHistory(history)}` : "";
  return { sets: results, problems, report: renderReport(results) + historySection };
}
