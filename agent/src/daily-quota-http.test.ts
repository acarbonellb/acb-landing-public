import { afterEach, describe, expect, it } from "vitest";
import { createApp, httpErrorMessages, paths, type AppDeps } from "./app";
import { createMemoryDailyQuota, createStoreDailyQuota } from "./daily-quota";
import { createMemoryDocumentStore } from "./document-store";
import { createFakeModel } from "./fake-model";
import { listen, type RunningServer } from "./server";
import { createMemorySpendCap } from "./spend-cap";
import { testAppDeps } from "./test-deps";

let servers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function start(deps: Partial<AppDeps>) {
  const server = await listen(createApp(testAppDeps(deps)), 0);
  servers.push(server);
  return server.url;
}

const origin = "https://albertocarbonell.dev";

function chat(url: string, ip: string, messages = [{ role: "user", content: "Who is Alberto?" }]) {
  return fetch(new URL(paths.chat, url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, Origin: origin },
    body: JSON.stringify({ messages }),
  });
}

/** Answers and waits for the stream to end, so its usage is charged. */
async function answered(res: Response) {
  expect(res.status).toBe(200);
  await res.text();
}

// One model call of at most 1,000 output tokens, at $20/MTok output and no
// input price: each chat request's worst case is $0.02, and a call that uses
// all 1,000 output tokens spends exactly that.
const outputOnly = { inputUsdPerMTok: 0, outputUsdPerMTok: 20 };
const chatLimits = { maxModelCalls: 1, maxTokens: 1000, maxRequestTokens: 1000 };
const fullAnswer = { text: "Hi.", usage: { inputTokens: 100, outputTokens: 1000 } };

describe("daily spend quota", () => {
  it("refuses a key that has spent its quota with 429 and when it resets; other keys go on", async () => {
    const model = createFakeModel([fullAnswer, fullAnswer, fullAnswer]);
    const url = await start({
      modelClient: model,
      chatLimits,
      dailyQuota: createMemoryDailyQuota({
        quotaUsd: 0.05,
        pricing: outputOnly,
        now: () => Date.parse("2026-11-15T22:00:00Z"),
      }),
    });

    await answered(await chat(url, "198.51.100.1"));
    await answered(await chat(url, "198.51.100.1"));
    // $0.04 spent: another $0.02 worst case doesn't fit in $0.05.
    const res = await chat(url, "198.51.100.1");

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7200");
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await res.json()).toEqual({
      error: {
        code: "rate_limited",
        message: httpErrorMessages.dailyQuota,
        retryAfterSeconds: 7200,
        resetsAt: "2026-11-16T00:00:00.000Z",
      },
    });
    expect(model.requests).toHaveLength(2);

    await answered(await chat(url, "198.51.100.2"));
  });

  it("counts a long conversation at its estimated cost, so it may not fit where a short one does", async () => {
    // Input only now: the worst case grows with the conversation. A short
    // question's is well under $0.04; nineteen messages of 2,000 characters
    // alone estimate 19K input tokens, plus the 1,000 the request may write
    // back in: $0.04 at $2/MTok before the system prompt and tools.
    const inputOnly = { inputUsdPerMTok: 2, outputUsdPerMTok: 0 };
    const model = createFakeModel([{ text: "Hi." }]);
    const url = await start({
      modelClient: model,
      chatLimits,
      dailyQuota: createMemoryDailyQuota({ quotaUsd: 0.04, pricing: inputOnly }),
    });
    const long = Array.from({ length: 18 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(2000),
    }));
    long.push({ role: "user", content: "y".repeat(2000) });

    expect((await chat(url, "198.51.100.1", long)).status).toBe(429);
    expect(model.requests).toHaveLength(0);
    await answered(await chat(url, "198.51.100.1"));
  });

  it("is shared by every instance on the same store and resets at UTC midnight", async () => {
    const store = createMemoryDocumentStore();
    let now = Date.parse("2026-11-15T23:59:00Z");
    const instance = () =>
      start({
        modelClient: createFakeModel([fullAnswer, fullAnswer]),
        chatLimits,
        dailyQuota: createStoreDailyQuota({
          store,
          quotaUsd: 0.03,
          pricing: outputOnly,
          now: () => now,
        }),
      });
    const [a, b] = [await instance(), await instance()];

    await answered(await chat(a, "198.51.100.1"));
    const refused = await chat(b, "198.51.100.1");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");

    now = Date.parse("2026-11-16T00:00:00Z");
    await answered(await chat(b, "198.51.100.1"));
  });

  it("releases what a refused request held, so the spend cap's refusal doesn't eat the quota", async () => {
    // The spend cap is closed: the chat answers 503 whatever the quota says.
    const dailyQuota = createMemoryDailyQuota({ quotaUsd: 0.03, pricing: outputOnly });
    const closed = await start({
      chatLimits,
      dailyQuota,
      spendCap: createMemorySpendCap({ budgetUsd: 0, pricing: outputOnly }),
    });
    for (let i = 0; i < 3; i++) expect((await chat(closed, "198.51.100.1")).status).toBe(503);

    const open = await start({
      modelClient: createFakeModel([fullAnswer]),
      chatLimits,
      dailyQuota,
    });
    await answered(await chat(open, "198.51.100.1"));
  });
});
