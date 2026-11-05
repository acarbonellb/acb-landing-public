// Record/replay at the model-client seam (docs/adr/0001). A live eval wraps the
// real client and keeps every call's events; CI replays them in order, so the
// chat loop and the tools run for real while no model is ever called.
import { createHash } from "node:crypto";
import type { ModelClient, ModelRequest, ModelStreamEvent } from "../model";
import { byString } from "./format";

/** One model call as it happened: what was asked (hashed) and what came back. */
export type RecordedCall = {
  requestHash: string;
  latencyMs: number;
  events: ModelStreamEvent[];
};

/** JSON with object keys sorted at every level, so key order never matters. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => byString(a, b)),
        )
      : v,
  );
}

/** SHA-256 of everything that reaches the model; never the abort signal. */
export function requestHash(request: ModelRequest): string {
  const { system, messages, tools, maxTokens } = request;
  return createHash("sha256")
    .update(canonicalJson({ system, messages, tools, maxTokens }))
    .digest("hex");
}

export type RecordingModelClient = ModelClient & {
  /** Completed calls, in order. A call that throws is not recorded. */
  calls: RecordedCall[];
};

export function createRecordingModelClient(
  inner: ModelClient,
  { now = () => performance.now() }: { now?: () => number } = {},
): RecordingModelClient {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async *stream(request) {
      // Before the call: the loop appends to `messages` once it returns.
      const hash = requestHash(request);
      const started = now();
      const events: ModelStreamEvent[] = [];
      for await (const event of inner.stream(request)) {
        events.push(event);
        yield event;
      }
      calls.push({ requestHash: hash, latencyMs: Math.round(now() - started), events });
    },
  };
}

export type StaleReason = "missing_recording" | "request_changed" | "missing_step";

const staleDetail: Record<StaleReason, string> = {
  missing_recording: "no recording",
  request_changed: "the request changed",
  missing_step: "more model calls than recorded",
};

/** The recording no longer answers what the code asks. Never re-recorded automatically. */
export class StaleRecordingError extends Error {
  constructor(
    readonly reason: StaleReason,
    /** 1-based model call within the case. */
    readonly call: number,
  ) {
    super(
      `Stale recording (${reason}: ${staleDetail[reason]} at call ${call}): re-run \`pnpm agent:eval\` and commit`,
    );
    this.name = "StaleRecordingError";
  }
}

export type ReplayModelClient = ModelClient & {
  /**
   * The stale error this client threw, if any. The chat loop turns thrown
   * errors into an `error` event, so the runner reads it from here.
   */
  staleError?: StaleRecordingError;
};

/** Plays `calls` back in order; `undefined` means the recording file is missing. */
export function createReplayModelClient(
  calls: RecordedCall[] | undefined,
): ReplayModelClient {
  let next = 0;
  const client: ReplayModelClient = {
    async *stream(request) {
      const call = ++next;
      const recorded = calls?.[call - 1];
      const reason: StaleReason | undefined = !calls
        ? "missing_recording"
        : !recorded
          ? "missing_step"
          : recorded.requestHash !== requestHash(request)
            ? "request_changed"
            : undefined;
      if (reason) throw (client.staleError = new StaleRecordingError(reason, call));
      yield* recorded!.events;
    },
  };
  return client;
}
