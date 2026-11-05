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

function listTools(url: string, forwardedFor = "203.0.113.7") {
  return fetch(new URL(paths.mcp, url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Forwarded-For": forwardedFor,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** A memory store that counts the writes made through it and can be taken down. */
function countingStore() {
  const inner = createMemoryDocumentStore();
  const counter = { writes: 0, down: false };
  const store: DocumentStore = {
    update: (path, change) => {
      if (counter.down) return Promise.reject(new Error("Firestore down"));
      return inner.update(path, (doc) => {
        const next = change(doc);
        if (next.doc) counter.writes++;
        return next;
      });
    },
  };
  return { store, counter };
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
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/usage/i), expect.any(Error));
    error.mockRestore();
  });

  it("answers MCP requests without waiting for the usage document", async () => {
    // A store whose writes hang until released, like a contended document.
    const inner = createMemoryDocumentStore();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const slow: DocumentStore = {
      update: async (path, change) => {
        await released;
        return inner.update(path, change);
      },
    };
    const { url } = await start([], { usage: createUsageRecorder({ store: slow, pricing }) });

    const answer = listTools(url).then((res) => res.status);
    const timeout = new Promise((resolve) => setTimeout(() => resolve("timed out"), 1000));
    expect(await Promise.race([answer, timeout])).toBe(200);

    release();
    await vi.waitFor(async () => expect((await stats(url)).current.mcp.requests).toBe(1));
  });

  it("writes a burst of refused chat requests in a batch, and /stats still counts each", async () => {
    const { store, counter } = countingStore();
    const usage = createUsageRecorder({ store, pricing });
    const { url } = await start([], {
      usage,
      chatRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
      spendCap: createMemorySpendCap({ budgetUsd: 0, pricing }),
    });

    const statuses = [];
    for (let i = 0; i < 20; i++) statuses.push((await chat(url)).status);
    expect(statuses.filter((s) => s === 503)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(19);

    const { chat: week } = (await stats(url)).current;
    expect(week).toMatchObject({ requests: 20, outcomes: { http_503: 1, http_429: 19 } });
    expect(counter.writes).toBeLessThanOrEqual(2);
  });

  it("keeps the refused requests' counts through a failed write, for the next one", async () => {
    const { store, counter } = countingStore();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { url } = await start([], {
      usage: createUsageRecorder({ store, pricing }),
      chatRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
      spendCap: createMemorySpendCap({ budgetUsd: 0, pricing }),
    });

    counter.down = true;
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await chat(url)).status);
    expect(statuses).toEqual([503, 429, 429]);
    expect((await fetch(new URL(paths.stats, url))).status).toBe(503);
    counter.down = false;

    expect((await stats(url)).current.chat.outcomes).toEqual({ http_503: 1, http_429: 2 });
    error.mockRestore();
  });

  describe("MCP requests from a Google address outside the fetchers ranges", () => {
    it("are counted, with no address, refused ones too", async () => {
      const { url } = await start([], {
        mcpRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
      });
      // Google-owned, not a user-triggered fetcher: where Hosting's peer
      // would show up if it moved outside the snapshot.
      const drifted = "198.51.100.1, 66.249.64.1";

      expect((await listTools(url, drifted)).status).toBe(200);
      expect((await listTools(url, drifted)).status).toBe(429);

      const res = await fetch(new URL(paths.stats, url), { headers: { "X-Forwarded-For": "203.0.113.9" } });
      const text = await res.text();
      expect(JSON.parse(text).current.mcp).toEqual({ requests: 1, unknownGoogleHops: 2 });
      expect(text).not.toMatch(/66\.249|198\.51/);
    });

    it("aren't counted through a fetcher hop, from elsewhere, or on the chat", async () => {
      const { url } = await start([{ text: "Hi." }]);

      expect((await listTools(url, "198.51.100.1, 66.249.93.229")).status).toBe(200);
      expect((await listTools(url, "198.51.100.1")).status).toBe(200);
      // A Google Cloud customer address: anyone can rent one.
      expect((await listTools(url, "198.51.100.1, 34.1.208.10")).status).toBe(200);
      const res = await fetch(new URL(paths.chat, url), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, "X-Forwarded-For": "66.249.64.1" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Who is Alberto?" }] }),
      });
      await res.text();

      expect((await stats(url)).current.mcp).toEqual({ requests: 3, unknownGoogleHops: 0 });
    });
  });
});
