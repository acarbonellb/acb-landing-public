import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, httpErrorMessages, paths, type AppDeps } from "./app";
import { createGuardrails } from "./compose";
import { loadConfig } from "./config";
import { createMemoryDailyQuota } from "./daily-quota";
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { createFakeModel } from "./fake-model";
import { createMemoryRateLimiter, rateLimitCollection } from "./rate-limit";
import { listen, type RunningServer } from "./server";
import { createMemorySpendCap, type SpendCap } from "./spend-cap";
import { testAppDeps } from "./test-deps";

let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(deps: Partial<AppDeps>) {
  server = await listen(createApp(testAppDeps(deps)), 0);
  return server.url;
}

const origin = "https://albertocarbonell.dev";

function chat(url: string, ip = "203.0.113.7") {
  return fetch(new URL(paths.chat, url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, Origin: origin },
    body: JSON.stringify({ messages: [{ role: "user", content: "Who is Alberto?" }] }),
  });
}

async function mcpClient(url: string, ip = "203.0.113.7") {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(paths.mcp, url), {
      requestInit: { headers: { "X-Forwarded-For": ip } },
    }),
  );
  return client;
}

const pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };

describe("chat rate limit", () => {
  it("answers 429 rate_limited with retry info once an IP exceeds the limit, without calling the model", async () => {
    const model = createFakeModel([{ text: "Hi." }, { text: "Hi again." }]);
    const url = await start({
      modelClient: model,
      chatRateLimiter: createMemoryRateLimiter({ limit: 2, windowMs: 60_000 }),
    });

    expect((await chat(url)).status).toBe(200);
    expect((await chat(url)).status).toBe(200);
    const res = await chat(url);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    // The browser can read it: CORS headers are on the error too.
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-expose-headers")).toMatch(/retry-after/i);
    expect(await res.json()).toEqual({
      error: {
        code: "rate_limited",
        message: expect.stringMatching(/too many/i),
        retryAfterSeconds: 60,
      },
    });
    expect(model.requests).toHaveLength(2);
  });

  it("limits each client IP separately and ignores spoofed X-Forwarded-For entries", async () => {
    const model = createFakeModel([{ text: "a" }, { text: "b" }]);
    const url = await start({
      modelClient: model,
      chatRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    expect((await chat(url, "198.51.100.1")).status).toBe(200);
    // Cloud Run appends the real client IP; earlier entries are client-supplied.
    expect((await chat(url, "10.0.0.99, 198.51.100.1")).status).toBe(429);
    expect((await chat(url, "198.51.100.2")).status).toBe(200);
  });

  it("keys on the right-most entry even after a Hosting peer (the chat is never behind Hosting)", async () => {
    const url = await start({
      modelClient: createFakeModel([{ text: "a" }, { text: "b" }]),
      chatRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    expect((await chat(url, "198.51.100.1, 66.249.93.229")).status).toBe(200);
    expect((await chat(url, "198.51.100.2, 66.249.93.229")).status).toBe(429);
  });

  it("keys an IPv6 client on its /64: addresses in one /64 share a window, other /64s don't", async () => {
    const url = await start({
      modelClient: createFakeModel([{ text: "a" }, { text: "b" }]),
      chatRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    expect((await chat(url, "2001:db8:0:1::1")).status).toBe(200);
    // Same /64, written differently.
    expect((await chat(url, "2001:0DB8:0000:0001:ffff:0:0:2")).status).toBe(429);
    // The neighbouring /64.
    expect((await chat(url, "2001:db8:0:2::1")).status).toBe(200);
  });

  it("keys each IPv4 address on its own, IPv4-mapped forms included", async () => {
    const url = await start({
      modelClient: createFakeModel([{ text: "a" }, { text: "b" }]),
      chatRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });

    expect((await chat(url, "::ffff:198.51.100.1")).status).toBe(200);
    // Mapped IPv4 addresses all sit in ::/64, but aren't one client.
    expect((await chat(url, "::ffff:198.51.100.2")).status).toBe(200);
    expect((await chat(url, "198.51.100.3")).status).toBe(200);
  });
});

describe("MCP rate limit", () => {
  it("answers 429 with Retry-After once an IP exceeds the limit", async () => {
    const url = await start({
      mcpRateLimiter: createMemoryRateLimiter({ limit: 2, windowMs: 30_000 }),
    });
    const listTools = (id: number) =>
      fetch(new URL(paths.mcp, url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Forwarded-For": "203.0.113.7",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
      });

    expect((await listTools(1)).status).toBe(200);
    expect((await listTools(2)).status).toBe(200);
    const res = await listTools(3);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toMatch(/retry-after/i);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: expect.stringMatching(/too many/i),
        data: { code: "rate_limited", retryAfterSeconds: 30 },
      },
    });
  });

  it("counts the visitor through the Hosting rewrite and ignores forged X-Forwarded-For entries", async () => {
    const url = await start({
      mcpRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    const listTools = (forwardedFor: string) =>
      fetch(new URL(paths.mcp, url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Forwarded-For": forwardedFor,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    // As measured in #36: Hosting sends `<visitor>,<its Google-owned peer>`.
    const hosting = (visitor: string) => `${visitor},66.249.93.229`;

    expect((await listTools(hosting("198.51.100.1"))).status).toBe(200);
    // The same visitor, through another Hosting peer or straight to run.app.
    expect((await listTools("198.51.100.1,66.249.93.199")).status).toBe(429);
    expect((await listTools("198.51.100.1")).status).toBe(429);
    // A direct caller forging entries is still keyed on their own IP.
    expect((await listTools("198.51.100.9, 198.51.100.1")).status).toBe(429);
    expect((await listTools(`${hosting("198.51.100.9")}, 198.51.100.1`)).status).toBe(429);
    // Other visitors through the rewrite each have their own limit.
    expect((await listTools(hosting("198.51.100.2"))).status).toBe(200);
  });

  it("doesn't skip a Google-owned address outside the user-triggered fetchers ranges", async () => {
    const url = await start({
      mcpRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    const listTools = (forwardedFor: string) =>
      fetch(new URL(paths.mcp, url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Forwarded-For": forwardedFor,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    // A direct caller from a Google-owned, non-fetcher IP (66.249.64.1),
    // forging the entry to its left: keyed on its own IP, so no fresh limit.
    expect((await listTools("198.51.100.1, 66.249.64.1")).status).toBe(200);
    expect((await listTools("198.51.100.2, 66.249.64.1")).status).toBe(429);
  });

  it("keys an IPv6 visitor on its /64, direct and through the Hosting rewrite", async () => {
    const url = await start({
      mcpRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    const listTools = (forwardedFor: string) =>
      fetch(new URL(paths.mcp, url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Forwarded-For": forwardedFor,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

    expect((await listTools("2001:db8:0:1::1,66.249.93.229")).status).toBe(200);
    // Another address in that /64, through the rewrite and straight to run.app.
    expect((await listTools("2001:db8:0:1:abcd::7,66.249.93.199")).status).toBe(429);
    expect((await listTools("2001:db8:0:1::99")).status).toBe(429);
    // Other /64s, either way.
    expect((await listTools("2001:db8:0:2::1,66.249.93.229")).status).toBe(200);
    expect((await listTools("2001:db8:0:3::1")).status).toBe(200);
  });

  it("is counted apart from the chat limit", async () => {
    const url = await start({
      modelClient: createFakeModel([{ text: "Hi." }]),
      chatRateLimiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    await (await chat(url)).text();
    expect((await chat(url)).status).toBe(429);
    const client = await mcpClient(url);
    const result = await client.callTool({ name: "get_profile", arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});

/** The production guardrails, in memory, with these environment overrides. */
function guardrails(env: Record<string, string>) {
  return createGuardrails(null, loadConfig(env));
}

function listTools(url: string, ip: string) {
  return fetch(new URL(paths.mcp, url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

describe("global rate-limit ceilings", () => {
  it("refuses /chat from many keys together past the global ceiling, with the same 429 as the per-IP limit", async () => {
    const model = createFakeModel([{ text: "a" }, { text: "b" }]);
    const url = await start({
      modelClient: model,
      ...guardrails({ RATE_LIMIT_CHAT_GLOBAL_PER_MINUTE: "2" }),
    });

    expect((await chat(url, "198.51.100.1")).status).toBe(200);
    expect((await chat(url, "198.51.100.2")).status).toBe(200);
    const res = await chat(url, "198.51.100.3");

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await res.json()).toEqual({
      error: {
        code: "rate_limited",
        message: httpErrorMessages.rateLimited,
        retryAfterSeconds: 60,
      },
    });
    expect(model.requests).toHaveLength(2);
  });

  it("refuses /mcp from many keys together past the global ceiling, with the same JSON-RPC error and Retry-After", async () => {
    const url = await start(guardrails({ RATE_LIMIT_MCP_GLOBAL_PER_MINUTE: "2" }));

    expect((await listTools(url, "198.51.100.1")).status).toBe(200);
    expect((await listTools(url, "198.51.100.2")).status).toBe(200);
    const res = await listTools(url, "198.51.100.3");

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("access-control-expose-headers")).toMatch(/retry-after/i);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: httpErrorMessages.rateLimited,
        data: { code: "rate_limited", retryAfterSeconds: 60 },
      },
    });
  });

  it("counts toward the ceiling only requests the per-IP limit let through", async () => {
    const url = await start({
      modelClient: createFakeModel([{ text: "a" }, { text: "b" }]),
      ...guardrails({ RATE_LIMIT_CHAT_PER_MINUTE: "1", RATE_LIMIT_CHAT_GLOBAL_PER_MINUTE: "2" }),
    });

    expect((await chat(url, "198.51.100.1")).status).toBe(200);
    // Refused by its own limit: doesn't use up the global ceiling.
    expect((await chat(url, "198.51.100.1")).status).toBe(429);
    expect((await chat(url, "198.51.100.2")).status).toBe(200);
  });
});

describe("local refusal cache over the shared store", () => {
  /** A memory store that counts the rate-limit windows it reads. */
  function countingStore() {
    const inner = createMemoryDocumentStore();
    const counter = { rateLimitReads: 0 };
    const store: DocumentStore = {
      update(path, change) {
        if (path.startsWith(`${rateLimitCollection}/`)) counter.rateLimitReads++;
        return inner.update(path, change);
      },
    };
    return { store, counter };
  }

  it("refuses a key again with no store read once the store has refused it, until its window ends", async () => {
    const { store, counter } = countingStore();
    const url = await start(
      createGuardrails(store, loadConfig({ RATE_LIMIT_MCP_PER_MINUTE: "1" })),
    );

    expect((await listTools(url, "198.51.100.1")).status).toBe(200);
    const refused = await listTools(url, "198.51.100.1");
    expect(refused.status).toBe(429);
    const readsAtFirstRefusal = counter.rateLimitReads;

    for (let i = 0; i < 3; i++) {
      const res = await listTools(url, "198.51.100.1");
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(counter.rateLimitReads).toBe(readsAtFirstRefusal);
    // Another key is still asked about, and allowed.
    expect((await listTools(url, "198.51.100.2")).status).toBe(200);
  });
});

describe("monthly spend cap", () => {
  it("answers 503 unavailable with a friendly message, without calling the model, once the spend cap is reached", async () => {
    const model = createFakeModel([]);
    const url = await start({
      modelClient: model,
      spendCap: createMemorySpendCap({
        capUsd: 0,
        pricing,
        now: () => Date.parse("2026-11-15T10:00:00Z"),
      }),
    });

    const res = await chat(url);
    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await res.json()).toEqual({
      error: {
        code: "unavailable",
        message: httpErrorMessages.spendCap,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    });
    expect(model.requests).toHaveLength(0);
  });

  it("records the tokens each chat spends and closes the chat when they reach the spend cap", async () => {
    // $4 input + $2 output = $6 per call against a $10 spend cap.
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
    const model = createFakeModel([
      { text: "One.", usage },
      { text: "Two.", usage },
      { text: "Three.", usage },
    ]);
    const url = await start({
      modelClient: model,
      spendCap: createMemorySpendCap({ capUsd: 10, pricing }),
      dailyQuota: createMemoryDailyQuota({ quotaUsd: 100, pricing }),
    });

    for (let i = 0; i < 2; i++) {
      const res = await chat(url);
      expect(res.status).toBe(200);
      await res.text(); // let the stream (and its usage) finish
    }
    expect((await chat(url)).status).toBe(503);
    expect(model.requests).toHaveLength(2);
  });

  it("charges input written to the prompt cache at its price, 1.25x the input price", async () => {
    // 1M input tokens, all written to the cache: $5 per call, not $4. Two
    // calls spend the $10 cap; at the base price, $2 would be left.
    const usage = { inputTokens: 1_000_000, cacheWriteInputTokens: 1_000_000, outputTokens: 0 };
    const model = createFakeModel([
      { text: "One.", usage },
      { text: "Two.", usage },
    ]);
    const url = await start({
      modelClient: model,
      spendCap: createMemorySpendCap({ capUsd: 10, pricing }),
      dailyQuota: createMemoryDailyQuota({ quotaUsd: 100, pricing }),
    });

    for (let i = 0; i < 2; i++) {
      const res = await chat(url);
      expect(res.status).toBe(200);
      await res.text();
    }
    expect((await chat(url)).status).toBe(503);
  });

  describe("with a request's worst case of $0.02 (1,000 output tokens) against a $0.03 spend cap", () => {
    const outputOnly = { inputUsdPerMTok: 0, outputUsdPerMTok: 20 };
    const chatLimits = { maxModelCalls: 1, maxTokens: 1000, maxRequestTokens: 1000 };

    /** A memory spend cap that tells when a request has settled. */
    function observedCap() {
      const cap = createMemorySpendCap({ capUsd: 0.03, pricing: outputOnly });
      let settled!: () => void;
      const settledOnce = new Promise<void>((resolve) => (settled = resolve));
      const spendCap: SpendCap = {
        async reserve(worstCase) {
          const status = await cap.reserve(worstCase);
          if (status.exhausted) return status;
          const { reservation } = status;
          return {
            exhausted: false,
            reservation: {
              record: (usage) => reservation.record(usage),
              settle: async () => {
                await reservation.settle();
                settled();
              },
            },
          };
        },
      };
      return { spendCap, settledOnce };
    }

    async function startChat(url: string, signal: AbortSignal) {
      const res = await fetch(new URL(paths.chat, url), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ messages: [{ role: "user", content: "Who is Alberto?" }] }),
        signal,
      });
      // Wait for the first streamed bytes: the model call is under way.
      await res.body!.getReader().read();
      return res;
    }

    it("holds a running chat's worst case, so a concurrent chat can't overshoot the spend cap", async () => {
      const { spendCap } = observedCap();
      const model = createFakeModel([{ text: "Thinking it over", hang: true }]);
      const url = await start({ modelClient: model, spendCap, chatLimits });
      const controller = new AbortController();

      await startChat(url, controller.signal);
      expect((await chat(url, "198.51.100.9")).status).toBe(503);
      expect(model.requests).toHaveLength(1);
      controller.abort();
    });

    it("still charges a chat the visitor abandons mid-answer, at its output cap", async () => {
      const { spendCap, settledOnce } = observedCap();
      const model = createFakeModel([
        { text: "Thinking it over", hang: true, usage: { inputTokens: 500, outputTokens: 0 } },
      ]);
      const url = await start({ modelClient: model, spendCap, chatLimits });
      const controller = new AbortController();

      await startChat(url, controller.signal);
      controller.abort();
      await settledOnce;

      // $0.02 charged for the abandoned call: another $0.02 doesn't fit.
      expect((await chat(url)).status).toBe(503);
    });
  });

  it("keeps the MCP tools working when the chat's spend cap is reached", async () => {
    const url = await start({
      modelClient: createFakeModel([]),
      spendCap: createMemorySpendCap({ capUsd: 0, pricing }),
    });
    const client = await mcpClient(url);
    const result = await client.callTool({ name: "get_contact", arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});
