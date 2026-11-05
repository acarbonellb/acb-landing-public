import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, paths, type AppDeps } from "./app";
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { createFakeModel, type ScriptedResponse } from "./fake-model";
import { createMemoryRateLimiter } from "./rate-limit";
import { listen, type RunningServer } from "./server";
import { createMemorySpendCap } from "./spend-cap";
import { testAppDeps } from "./test-deps";
import { createUsageRecorder, type StatsResponse } from "./usage";

let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };
const origin = "https://albertocarbonell.dev";

async function start(script: ScriptedResponse[], deps: Partial<AppDeps> = {}) {
  const store = createMemoryDocumentStore();
  const usage = createUsageRecorder({ store, pricing });
  server = await listen(
    createApp(testAppDeps({ modelClient: createFakeModel(script), usage, ...deps })),
    0,
  );
  return { url: server.url, store };
}

async function chat(url: string) {
  const res = await fetch(new URL(paths.chat, url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ messages: [{ role: "user", content: "Who is Alberto?" }] }),
  });
  return { status: res.status, body: await res.text() };
}

async function stats(url: string): Promise<StatsResponse> {
  const res = await fetch(new URL(paths.stats, url));
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /stats", () => {
  it("serves this and last week's aggregates to any origin, cacheable for a few minutes", async () => {
    const { url } = await start([]);
    const res = await fetch(new URL(paths.stats, url), { headers: { Origin: "https://elsewhere.example" } });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = (await res.json()) as StatsResponse;
    expect(Object.keys(body)).toEqual(["current", "previous"]);
    expect(body.current.week).toMatch(/^\d{4}-W\d{2}$/);
    expect(body.current.chat.requests).toBe(0);
  });

  it("is under the MCP rate limit", async () => {
    const { url } = await start([], {
      mcpRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    expect((await fetch(new URL(paths.stats, url))).status).toBe(200);
    const res = await fetch(new URL(paths.stats, url));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("keys its limit on the right-most X-Forwarded-For entry, even after a Hosting peer", async () => {
    const { url } = await start([], {
      mcpRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    const get = (forwardedFor: string) =>
      fetch(new URL(paths.stats, url), { headers: { "X-Forwarded-For": forwardedFor } });
    expect((await get("198.51.100.1, 66.249.93.229")).status).toBe(200);
    expect((await get("198.51.100.2, 66.249.93.229")).status).toBe(429);
  });

  it("answers 503 when the aggregates can't be read", async () => {
    const broken: DocumentStore = {
      update: async () => {
        throw new Error("Firestore down");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { url } = await start([], { usage: createUsageRecorder({ store: broken, pricing }) });
    const res = await fetch(new URL(paths.stats, url));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "unavailable", message: expect.any(String) } });
    error.mockRestore();
  });
});

describe("usage recording", () => {
  it("folds each chat request's outcome, tokens and latency into the week", async () => {
    const { url } = await start([
      { text: "Alberto is an engineer.", usage: { inputTokens: 1000, outputTokens: 100 } },
      { error: new Error("boom") },
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await chat(url)).status).toBe(200);
    expect((await chat(url)).body).toMatch(/event: error/);
    error.mockRestore();

    const { chat: week } = (await stats(url)).current;
    expect(week).toMatchObject({
      requests: 2,
      answered: 1,
      outcomes: { end_turn: 1, "error:internal": 1 },
      errorRate: 0.5,
    });
    // The failed call reported its input (100 tokens) and is charged at its cap.
    expect(week.inputTokens).toBe(1100);
    expect(week.costUsd).toBeGreaterThan(0);
    expect(week.latency.p50Ms).not.toBeNull();
    expect(week.firstText.p50Ms).not.toBeNull();
  });

  it("counts refusals before streaming: 429 and 503", async () => {
    const { url } = await start([], {
      chatRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
      spendCap: createMemorySpendCap({ budgetUsd: 0, pricing }),
    });
    expect((await chat(url)).status).toBe(503);
    expect((await chat(url)).status).toBe(429);

    const { chat: week } = (await stats(url)).current;
    expect(week).toMatchObject({
      requests: 2,
      answered: 0,
      outcomes: { http_429: 1, http_503: 1 },
      errorRate: null,
      latency: { p50Ms: null, p95Ms: null },
    });
  });

  it("counts MCP requests, but not the stats' own", async () => {
    const { url } = await start([]);
    let sent = 0;
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(paths.mcp, url), {
        fetch: (input, init) => {
          sent++;
          return fetch(input, init);
        },
      }),
    );
    await client.listTools();
    await client.close();
    await stats(url);

    const { current } = await stats(url);
    // Every HTTP request of the session: initialize, tools/list...
    expect(sent).toBeGreaterThanOrEqual(3);
    expect(current.mcp.requests).toBe(sent);
    expect(current.chat.requests).toBe(0);
  });

  it("never fails the chat when usage can't be recorded", async () => {
    const broken: DocumentStore = {
      update: async () => {
        throw new Error("Firestore down");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { url } = await start([{ text: "Hi." }], {
      usage: createUsageRecorder({ store: broken, pricing }),
    });

    const res = await chat(url);
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/event: done/);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/"event":"store_error".*Usage: could not record.*Firestore down/),
    );
    error.mockRestore();
  });
});
