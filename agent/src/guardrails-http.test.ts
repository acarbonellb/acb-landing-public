import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, paths, type AppDeps } from "./app";
import { errorMessages } from "./chat";
import { createFakeModel } from "./fake-model";
import { createMemoryRateLimiter } from "./rate-limit";
import { listen, type RunningServer } from "./server";
import { createMemorySpendCap } from "./spend-cap";

let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(deps: Partial<AppDeps>) {
  server = await listen(createApp(deps), 0);
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

describe("monthly spend cap", () => {
  it("answers 503 unavailable with a friendly message, without calling the model, once the budget is spent", async () => {
    const model = createFakeModel([]);
    const url = await start({
      modelClient: model,
      spendCap: createMemorySpendCap({
        budgetUsd: 0,
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
        message: errorMessages.spendCap,
        resetsAt: "2026-12-01T00:00:00.000Z",
      },
    });
    expect(model.requests).toHaveLength(0);
  });

  it("records the tokens each chat spends and closes the chat when they reach the budget", async () => {
    // $4 input + $2 output = $6 per call against a $10 budget.
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
    const model = createFakeModel([
      { text: "One.", usage },
      { text: "Two.", usage },
      { text: "Three.", usage },
    ]);
    const url = await start({
      modelClient: model,
      spendCap: createMemorySpendCap({ budgetUsd: 10, pricing }),
    });

    for (let i = 0; i < 2; i++) {
      const res = await chat(url);
      expect(res.status).toBe(200);
      await res.text(); // let the stream (and its usage) finish
    }
    expect((await chat(url)).status).toBe(503);
    expect(model.requests).toHaveLength(2);
  });

  it("keeps the MCP tools working when the chat budget is spent", async () => {
    const url = await start({
      modelClient: createFakeModel([]),
      spendCap: createMemorySpendCap({ budgetUsd: 0, pricing }),
    });
    const client = await mcpClient(url);
    const result = await client.callTool({ name: "get_contact", arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});
