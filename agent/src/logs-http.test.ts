// Structured logs and alert events, observed through the HTTP app: requests
// go in, the JSON lines the agent writes to stdout/stderr come out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, paths, type AppDeps } from "./app";
import { createGuardrails } from "./compose";
import { loadConfig } from "./config";
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { createFakeModel, type ScriptedResponse } from "./fake-model";
import { createMemoryRateLimiter } from "./rate-limit";
import { listen, type RunningServer } from "./server";
import { createStoreSpendCap } from "./spend-cap";
import { testAppDeps } from "./test-deps";
import { createToolset, siteContent } from "./tools";

let server: RunningServer | undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

const origin = "https://albertocarbonell.dev";
const unlimited = createMemoryRateLimiter({ limit: 1000, windowMs: 60_000 });

async function start(deps: Partial<AppDeps> = {}) {
  server = await listen(createApp(testAppDeps(deps)), 0);
  return server.url;
}

/** Every line logged so far, to stdout or stderr, in the order written. */
function loggedLines(): string[] {
  return [vi.mocked(console.log), vi.mocked(console.error)]
    .flatMap(({ mock }) =>
      mock.calls.map((args, i) => ({ order: mock.invocationCallOrder[i], line: args.map(String).join(" ") })),
    )
    .sort((a, b) => a.order - b.order)
    .map(({ line }) => line);
}

/** The structured events logged so far, optionally only those named `event`. */
function loggedEvents(event?: string): Record<string, unknown>[] {
  return loggedLines()
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    })
    .filter((entry) => event === undefined || entry.event === event);
}

async function chat(url: string, content = "Who is Alberto?", headers: Record<string, string> = {}) {
  const res = await fetch(new URL(paths.chat, url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
  return { status: res.status, requestId: res.headers.get("x-request-id"), body: await res.text() };
}

describe("the chat request log line", () => {
  it("logs one line per streamed request: outcome, tokens, cost, latency and model calls", async () => {
    const script: ScriptedResponse[] = [
      {
        toolCalls: [{ id: "t1", name: "get_projects", input: {} }],
        usage: { inputTokens: 1000, outputTokens: 50 },
      },
      { text: "He builds things.", usage: { inputTokens: 1200, outputTokens: 100 } },
    ];
    const url = await start({ modelClient: createFakeModel(script) });

    const res = await chat(url);

    expect(res.status).toBe(200);
    const lines = loggedEvents("chat_request");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity: "INFO",
      requestId: res.requestId,
      outcome: "end_turn",
      inputTokens: 2200,
      outputTokens: 150,
      modelCalls: 2,
    });
    // The default model's list prices: $0.10 in, $0.50 out per million tokens.
    expect(lines[0].costUsd).toBeCloseTo(0.000295, 9);
    expect(lines[0].totalMs).toEqual(expect.any(Number));
    expect(lines[0].firstTextMs).toEqual(expect.any(Number));
    expect(res.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs one line for a request refused before streaming, or malformed", async () => {
    const url = await start({ chatRateLimiter: createMemoryRateLimiter({ limit: 2, windowMs: 60_000 }) });

    const malformed = await fetch(new URL(paths.chat, url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: "{",
    });
    await chat(url); // the fake model has nothing scripted: an internal error
    const refused = await chat(url);

    expect(malformed.status).toBe(400);
    expect(refused.status).toBe(429);
    const lines = loggedEvents("chat_request");
    expect(lines.map((line) => line.outcome)).toEqual(["http_400", "error:internal", "http_429"]);
    expect(lines[0]).toMatchObject({ requestId: malformed.headers.get("x-request-id"), modelCalls: 0 });
    expect(lines[2]).toMatchObject({
      requestId: refused.requestId,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      modelCalls: 0,
    });
  });
});

describe("what the logs never carry", () => {
  it("has no message content, client IP or contact email in any line", async () => {
    const email = "someone@example.com";
    const ip = "203.0.113.7";
    const question = "What does Alberto do on weekends?";
    const answer = "He hikes.";
    const url = await start({
      toolset: createToolset({ ...siteContent, contactEmail: email }),
      modelClient: createFakeModel([
        { toolCalls: [{ id: "t1", name: "get_contact", input: {} }], usage: { inputTokens: 10, outputTokens: 5 } },
        { text: answer, usage: { inputTokens: 20, outputTokens: 5 } },
        { error: new Error("model exploded"), usage: { inputTokens: 1, outputTokens: 0 } },
      ]),
    });

    const answered = await chat(url, question, { "X-Forwarded-For": ip });
    await chat(url, question, { "X-Forwarded-For": ip });
    await fetch(new URL(paths.stats, url), { headers: { "X-Forwarded-For": ip } });

    expect(answered.body).toContain(email); // the tool result did stream back
    const logged = loggedLines().join("\n");
    expect(loggedEvents("chat_request")).toHaveLength(2);
    expect(logged).not.toContain(email);
    expect(logged).not.toContain(ip);
    expect(logged).not.toContain(question);
    expect(logged).not.toContain(answer);
  });
});

describe("store failure events", () => {
  /** A memory store that fails every update while `down` is set. */
  function flakyStore() {
    const store = createMemoryDocumentStore();
    const flaky: DocumentStore & { down: boolean } = {
      down: false,
      update: (path, change) =>
        flaky.down ? Promise.reject(new Error("store unreachable")) : store.update(path, change),
    };
    return flaky;
  }

  it("logs store_unavailable once when the store starts failing, and store_recovered once it works again", async () => {
    const store = flakyStore();
    const url = await start(createGuardrails(store, loadConfig({})));
    const stats = () => fetch(new URL(paths.stats, url));

    await stats();
    store.down = true;
    await stats();
    await stats();
    await chat(url);
    store.down = false;
    await stats();
    await stats();
    store.down = true;
    await stats();

    const events = loggedEvents().filter((e) => String(e.event).startsWith("store_"));
    expect(events.filter((e) => e.event !== "store_error").map((e) => e.event)).toEqual([
      "store_unavailable",
      "store_recovered",
      "store_unavailable",
    ]);
    expect(events.find((e) => e.event === "store_unavailable")).toMatchObject({
      severity: "ERROR",
      collection: "rateLimits",
      error: "Error: store unreachable",
    });
    // Each failure is still logged on its own, tagged with its request.
    expect(events.filter((e) => e.event === "store_error").length).toBeGreaterThanOrEqual(4);
    expect(events.filter((e) => e.event === "store_error").every((e) => typeof e.requestId === "string")).toBe(true);
  });
});

/** A clock the test moves by hand. */
function clock(iso: string) {
  let t = Date.parse(iso);
  return { now: () => t, set: (next: string) => (t = Date.parse(next)) };
}

describe("spend alert events", () => {
  // $1 per output token, nothing for input; each answer spends $2 of a $10
  // budget, and reserves its worst case of $2 while it runs.
  const pricing = { inputUsdPerMTok: 0, outputUsdPerMTok: 1_000_000 };
  const chatLimits = { maxModelCalls: 1, maxTokens: 2, maxRequestTokens: 2 };
  const answer: ScriptedResponse = { text: "Hi.", usage: { inputTokens: 10, outputTokens: 2 } };

  async function startSpending(time: ReturnType<typeof clock>, store = createMemoryDocumentStore()) {
    return start({
      chatLimits,
      chatRateLimiter: unlimited,
      modelClient: createFakeModel(Array.from({ length: 20 }, () => answer)),
      spendCap: createStoreSpendCap({ store, budgetUsd: 10, pricing, now: time.now }),
    });
  }

  it("logs spend_threshold once at 50% and once at 80% of the cap, whatever the requests after", async () => {
    const url = await startSpending(clock("2026-11-05T12:00:00Z"));

    for (let i = 0; i < 5; i++) expect((await chat(url)).status).toBe(200); // $2 … $10

    const events = loggedEvents("spend_threshold");
    expect(events).toEqual([
      expect.objectContaining({
        severity: "WARNING",
        thresholdPercent: 50,
        month: "2026-11",
        spentUsd: 6,
        budgetUsd: 10,
      }),
      expect.objectContaining({ severity: "WARNING", thresholdPercent: 80, spentUsd: 8 }),
    ]);
    expect(typeof events[0].requestId).toBe("string");
  });

  it("logs spend_cap_reached once, with the reopening date, when the cap first closes the chat", async () => {
    const url = await startSpending(clock("2026-11-05T12:00:00Z"));
    for (let i = 0; i < 5; i++) await chat(url);

    const refused = [await chat(url), await chat(url), await chat(url)];

    expect(refused.map((r) => r.status)).toEqual([503, 503, 503]);
    expect(loggedEvents("spend_cap_reached")).toEqual([
      expect.objectContaining({
        severity: "ERROR",
        month: "2026-11",
        spentUsd: 10,
        budgetUsd: 10,
        resetsAt: "2026-12-01T00:00:00.000Z",
        requestId: refused[0].requestId,
      }),
    ]);
  });

  it("holds once-per-crossing across instances and cold starts (the state is in the shared store)", async () => {
    const store = createMemoryDocumentStore();
    const time = clock("2026-11-05T12:00:00Z");
    let url = await startSpending(time, store);
    for (let i = 0; i < 3; i++) await chat(url); // $6: past 50%

    // A cold start: a fresh app on the same store.
    await server?.close();
    url = await startSpending(time, store);
    await chat(url); // $8: past 80%
    await chat(url); // $10
    await chat(url); // closed

    await server?.close();
    url = await startSpending(time, store);
    await chat(url); // still closed

    expect(loggedEvents("spend_threshold").map((e) => e.thresholdPercent)).toEqual([50, 80]);
    expect(loggedEvents("spend_cap_reached")).toHaveLength(1);
  });

  it("fires again in a new month, which starts from nothing", async () => {
    const time = clock("2026-11-30T23:00:00Z");
    const url = await startSpending(time);
    for (let i = 0; i < 6; i++) await chat(url);

    time.set("2026-12-01T00:30:00Z");
    for (let i = 0; i < 6; i++) await chat(url);

    expect(loggedEvents("spend_threshold").map((e) => `${e.month} ${e.thresholdPercent}`)).toEqual([
      "2026-11 50",
      "2026-11 80",
      "2026-12 50",
      "2026-12 80",
    ]);
    expect(loggedEvents("spend_cap_reached").map((e) => e.resetsAt)).toEqual([
      "2026-12-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
  });
});
