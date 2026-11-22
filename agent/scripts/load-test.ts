// Local load test of the guardrails, over the Firestore emulator with a fake
// model client; refused unless the store is the emulator on this machine
// (`src/load-test-guard.ts`). How to run it: docs/development.md; its latest
// result: docs/guardrails.md.
//
//   AGENT_STORE=firestore FIRESTORE_PROJECT_ID=load-test FIRESTORE_EMULATOR_HOST=localhost:8091 \
//     pnpm agent:load-test [--seconds 120] [--shape steady|burst]
//
// Per endpoint, two streams of requests: one on a fresh rate-limit key per
// request at twice the global ceiling (so only the ceiling can refuse them),
// and one on a single key at twice the per-key limit. `steady` spaces each
// stream's requests evenly; `burst` sends each minute's requests all at once,
// at the start of the minute.
import { parseArgs } from "node:util";
import { createAnswerSigner, ephemeralSigningKey } from "../src/answer-signing";
import { createApp, httpErrorMessages, paths } from "../src/app";
import { assembleAppDeps } from "../src/compose";
import { loadConfig } from "../src/config";
import { createFakeModel } from "../src/fake-model";
import { createFirestoreDocumentStore } from "../src/firestore";
import { emulatorStoreOrRefuse } from "../src/load-test-guard";
import type { ModelClient } from "../src/model";
import { listen } from "../src/server";
import { createToolset, siteContent } from "../src/tools";

const windowMs = 60_000;

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "120" },
    shape: { type: "string", default: "steady" },
  },
});
const durationMs = Number(values.seconds) * 1000;
const shape = values.shape;
if (!(durationMs > 0) || (shape !== "steady" && shape !== "burst")) {
  console.error("Usage: pnpm agent:load-test [--seconds <n>] [--shape steady|burst]");
  process.exit(1);
}

// The guard first: nothing is built before the store is known to be the emulator.
const config = loadConfig();
const emulator = emulatorStoreOrRefuse(config.store);
const { guardrails } = config;

// --- The store, counted at the REST boundary -------------------------------

const conflictStatuses = new Set(["ABORTED", "ALREADY_EXISTS", "FAILED_PRECONDITION"]);
const store = {
  reads: 0,
  writes: {} as Record<string, number>,
  conflicts: {} as Record<string, number>,
  failures: 0,
};
const bump = (counts: Record<string, number>, key: string) => (counts[key] = (counts[key] ?? 0) + 1);

/** `fetch` to the emulator, counting each read, landed commit and conflict by collection. */
const countingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (init?.method !== "POST") {
    store.reads++;
    return res;
  }
  const body = JSON.parse(String(init.body)) as { writes: { update: { name: string } }[] };
  const collection = body.writes[0].update.name.split("/documents/")[1].split("/")[0];
  if (res.ok) bump(store.writes, collection);
  else {
    const status = ((await res.clone().json()) as { error?: { status?: string } }).error?.status;
    if (status && conflictStatuses.has(status)) bump(store.conflicts, collection);
    else store.failures++;
  }
  return res;
};

// A project of its own per run: the emulator keeps it apart, so each run
// starts from an empty store.
const projectId = `${emulator.projectId}-${Date.now()}`;
const documentStore = createFirestoreDocumentStore({ ...emulator, projectId, fetch: countingFetch });

// --- The agent, as production wires it, with a fake model ------------------

/** Answers every call with a short text: a fresh one-response fake per call. */
const fakeModel: ModelClient = {
  stream: (request) => createFakeModel([{ text: "A portfolio site and an agent that answers about it." }]).stream(request),
};

const deps = assembleAppDeps({
  config,
  sharedStore: documentStore,
  modelClient: fakeModel,
  answerSigner: createAnswerSigner(ephemeralSigningKey()),
  toolset: createToolset({ ...siteContent, contactEmail: undefined }),
});

// The agent's log lines, counted by event instead of printed.
const logged: Record<string, number> = {};
const print = console.log.bind(console);
const countLine = (line: unknown) => {
  try {
    bump(logged, (JSON.parse(String(line)) as { event: string }).event);
  } catch {
    process.stderr.write(`${String(line)}\n`);
  }
};
console.log = countLine;
console.error = countLine;
console.warn = countLine;

const server = await listen(createApp(deps), 0, "127.0.0.1");

// --- The flood --------------------------------------------------------------

type Endpoint = "chat" | "mcp" | "stats";
type StreamKind = "rotating keys" | "one key";
type Outcome = { kind: "ok" } | { kind: "refused"; reason: string } | { kind: "error"; reason: string };
type Result = { endpoint: Endpoint; stream: StreamKind; key: string; sentAt: number; latency: number; outcome: Outcome };

const limits: Record<Endpoint, { perKey: number; ceiling: number }> = {
  chat: { perKey: guardrails.chatRequestsPerMinute, ceiling: guardrails.chatGlobalRequestsPerMinute },
  mcp: { perKey: guardrails.mcpRequestsPerMinute, ceiling: guardrails.mcpGlobalRequestsPerMinute },
  stats: { perKey: guardrails.statsRequestsPerMinute, ceiling: guardrails.statsGlobalRequestsPerMinute },
};

/** The `n`th made-up IPv4 rate-limit key, in the private 10/8 block. */
const keyOf = (n: number) => [10, (n >> 16) & 255, (n >> 8) & 255, n & 255].join(".");
let nextKey = 1;
const freshKey = () => keyOf(nextKey++);

/** Send times (ms from the start) of `perMinute` requests a minute for the run. */
function schedule(perMinute: number): number[] {
  if (shape === "burst") {
    const minutes = Math.ceil(durationMs / windowMs);
    return Array.from({ length: minutes }, (_, m) => Array<number>(perMinute).fill(m * windowMs)).flat();
  }
  const spacing = windowMs / perMinute;
  return Array.from({ length: Math.floor(durationMs / spacing) }, (_, i) => i * spacing);
}

/** The error JSON of `/chat` and `/stats`, or the JSON-RPC error of `/mcp`. */
type ErrorBody = { error?: { code?: string | number; message?: string; resetsAt?: string; data?: { code?: string } } };

/** The error's code: the HTTP error code, which `/mcp` puts in `data`. */
const codeOf = (text: string) => {
  const { error } = JSON.parse(text) as ErrorBody;
  return error?.data?.code ?? String(error?.code);
};

/** A 429's reason: `rate_limited` from a rate limit or ceiling, `daily_quota` from the quota. */
const refusalReason = (text: string) => ((JSON.parse(text) as ErrorBody).error?.resetsAt ? "daily_quota" : codeOf(text));

async function send(endpoint: Endpoint, key: string): Promise<Outcome> {
  const headers = { "X-Forwarded-For": key };
  if (endpoint === "stats") {
    const res = await fetch(`${server.url}${paths.stats}`, { headers });
    const text = await res.text();
    if (res.status === 200) return { kind: "ok" };
    if (res.status === 429) return { kind: "refused", reason: refusalReason(text) };
    return { kind: "error", reason: `${res.status} ${codeOf(text)}` };
  }
  if (endpoint === "mcp") {
    const res = await fetch(`${server.url}${paths.mcp}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_contact", arguments: {} } }),
    });
    const text = await res.text();
    if (res.status === 429) return { kind: "refused", reason: refusalReason(text) };
    if (res.status !== 200) return { kind: "error", reason: `${res.status} ${codeOf(text)}` };
    return /"error"\s*:\s*\{/.test(text) ? { kind: "error", reason: "json-rpc error" } : { kind: "ok" };
  }
  const res = await fetch(`${server.url}${paths.chat}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: config.allowedOrigins[0] },
    body: JSON.stringify({ messages: [{ role: "user", content: "What is Alberto building?" }] }),
  });
  const text = await res.text();
  if (res.status === 429) return { kind: "refused", reason: refusalReason(text) };
  if (res.status === 503 && (JSON.parse(text) as ErrorBody).error?.message === httpErrorMessages.spendCap) {
    return { kind: "refused", reason: "spend_cap" };
  }
  if (res.status !== 200) return { kind: "error", reason: `${res.status} ${codeOf(text)}` };
  const streamError = /event: error\ndata: (.*)/.exec(text);
  if (streamError) return { kind: "error", reason: `stream ${(JSON.parse(streamError[1]) as { code: string }).code}` };
  return /event: done/.test(text) ? { kind: "ok" } : { kind: "error", reason: "stream without done" };
}

const start = performance.now();
const results: Result[] = [];
const inFlight: Promise<void>[] = [];

function plan(endpoint: Endpoint, stream: StreamKind, perMinute: number) {
  const hotKey = freshKey();
  for (const at of schedule(perMinute)) {
    const key = stream === "one key" ? hotKey : freshKey();
    inFlight.push(
      new Promise<void>((done) =>
        setTimeout(async () => {
          const sentAt = performance.now() - start;
          let outcome: Outcome;
          try {
            outcome = await send(endpoint, key);
          } catch (error) {
            outcome = { kind: "error", reason: `network: ${(error as Error).message}` };
          }
          results.push({ endpoint, stream, key, sentAt, latency: performance.now() - start - sentAt, outcome });
          done();
        }, at),
      ),
    );
  }
}

for (const endpoint of ["chat", "mcp", "stats"] as const) {
  plan(endpoint, "rotating keys", 2 * limits[endpoint].ceiling);
  plan(endpoint, "one key", 2 * limits[endpoint].perKey);
}
print(`Load test: ${shape}, ${durationMs / 1000} s, store on the emulator at ${emulator.emulatorHost} (project ${projectId})`);
await Promise.all(inFlight);
const elapsedMs = performance.now() - start;
await server.close();

// --- The report ------------------------------------------------------------

/** Refused by a rate limit or ceiling: the only refusals that mean "not let through". */
const rateLimited = (r: Result) => r.outcome.kind === "refused" && r.outcome.reason === "rate_limited";

/**
 * The most requests a fixed-window limit of `limit` can let through over
 * `rs`: one window opens at the first request the limit lets through and
 * lasts `windowMs`, so the windows that fit between the first send and the
 * last arrival bound it, whatever the implementation does.
 */
function mostLetThrough(rs: Result[], limit: number): number {
  if (rs.length === 0) return 0;
  const first = Math.min(...rs.map((r) => r.sentAt));
  const lastArrival = Math.max(...rs.map((r) => r.sentAt + r.latency));
  return limit * (Math.floor((lastArrival - first) / windowMs) + 1);
}

const tally = (rs: Result[], kind: Outcome["kind"]) =>
  rs.reduce<Record<string, number>>((counts, r) => {
    if (r.outcome.kind === kind && kind !== "ok") bump(counts, (r.outcome as { reason: string }).reason);
    return counts;
  }, {});

const overLimit: string[] = [];
const rows = (["chat", "mcp", "stats"] as const).map((endpoint) => {
  const all = results.filter((r) => r.endpoint === endpoint);
  const oneKey = all.filter((r) => r.stream === "one key");
  const through = all.filter((r) => !rateLimited(r)).length;
  const throughOneKey = oneKey.filter((r) => !rateLimited(r)).length;
  const ceilingMax = mostLetThrough(all, limits[endpoint].ceiling);
  const perKeyMax = mostLetThrough(oneKey, limits[endpoint].perKey);
  if (through > ceilingMax) overLimit.push(`/${endpoint} global ceiling: ${through} let through, at most ${ceilingMax}`);
  if (throughOneKey > perKeyMax) overLimit.push(`/${endpoint} per-key limit: ${throughOneKey} let through, at most ${perKeyMax}`);
  const latencies = all.map((r) => r.latency).sort((a, b) => a - b);
  return {
    endpoint: `/${endpoint}`,
    requests: all.length,
    ok: all.filter((r) => r.outcome.kind === "ok").length,
    refused: tally(all, "refused"),
    errors: tally(all, "error"),
    letThrough: `${through} (ceiling ${limits[endpoint].ceiling}/min, at most ${ceilingMax})`,
    letThroughOneKey: `${throughOneKey} of ${oneKey.length} (limit ${limits[endpoint].perKey}/min, at most ${perKeyMax})`,
    p50Ms: Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0),
    maxMs: Math.round(latencies.at(-1) ?? 0),
  };
});

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
print(
  JSON.stringify(
    {
      shape,
      seconds: Math.round(elapsedMs / 1000),
      requests: results.length,
      endpoints: rows,
      store: {
        writes: { total: sum(store.writes), ...store.writes },
        reads: store.reads,
        conflicts: { total: sum(store.conflicts), ...store.conflicts },
        otherFailures: store.failures,
      },
      loggedEvents: logged,
      overLimit,
    },
    null,
    2,
  ),
);
print(overLimit.length ? `FAIL: ${overLimit.length} limit(s) let through more than their limit.` : "PASS: no limit let through more than its limit.");
process.exit(overLimit.length ? 1 : 0);
