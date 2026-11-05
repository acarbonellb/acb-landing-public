// Structured logs: one JSON line per event, which Cloud Logging parses
// natively (`severity` sets the entry's severity, `message` its summary, the
// rest lands in `jsonPayload`). Every line has a stable `event` name; the
// README ("Logs and alert events") lists them with their fields, and the
// Cloud Monitoring alerts match on them.
//
// A line logged while a request is being served carries that request's
// `requestId` (kept in an AsyncLocalStorage by `withRequestId`), so a chat
// stream's events and its store writes can be tied together.
//
// No line carries message content, a client IP or the contact email: fields
// are counts, ids, outcomes and error messages that are scrubbed at the
// source (`firestore.ts` names the collection only, never a document id).
import { AsyncLocalStorage } from "node:async_hooks";

export type Severity = "INFO" | "WARNING" | "ERROR";

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** Runs `fn` with every line it logs tagged with `requestId`. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

/** The id of the request being served, if any. */
export const currentRequestId = (): string | undefined => requestContext.getStore()?.requestId;

/** An error as one loggable string: its name and message (and its cause's). */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const own = `${error.name}: ${error.message}`;
  return error.cause === undefined ? own : `${own} (cause: ${describeError(error.cause)})`;
}

/**
 * Logs one event. INFO goes to stdout, WARNING and ERROR to stderr; Cloud
 * Run sends both to Cloud Logging. Fields left `undefined` are dropped.
 */
export function logEvent(
  severity: Severity,
  event: string,
  message: string,
  fields: LogFields = {},
): void {
  const line = JSON.stringify({ severity, event, message, requestId: currentRequestId(), ...fields });
  if (severity === "INFO") console.log(line);
  else console.error(line);
}
