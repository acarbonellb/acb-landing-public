// The store writes one request costs, as checked numbers: a chat request
// writes its daily quota and the month's spend cap once each to reserve and
// once each to settle, whatever number of model calls it makes, plus its
// usage stats; an MCP request writes nothing of its own, only the usage batch
// when one is due. And since what a request spends is only in its instance's
// memory until it settles, a hold that expires unsettled is charged at its
// worst case.
import { describe, expect, it } from "vitest";
import { createApp, paths } from "./app";
import { createGuardrails } from "./compose";
import { loadConfig } from "./config";
import { createStoreDailyQuota, dailySpendCollection } from "./daily-quota";
import type { DocumentStore, StoreDocument } from "./document-store";
import { createFakeModel } from "./fake-model";
import { createStoreSpendCap, spendCollection, spendPath } from "./spend-cap";
import { countingStore, testAppDeps } from "./test-deps";
import { createUsageRecorder, defaultFlushEveryMs, usageCollection } from "./usage";

const origin = "https://albertocarbonell.dev";
const pricing = loadConfig({}).guardrails.pricing;

type App = ReturnType<typeof createApp>;

const chat = (app: App, init: RequestInit = {}, ctx?: Parameters<App["fetch"]>[2]) =>
  app.fetch(
    new Request(new URL(paths.chat, "http://agent.test"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7", Origin: origin },
      body: JSON.stringify({ messages: [{ role: "user", content: "What is Alberto building?" }] }),
      ...init,
    }),
    {},
    ctx,
  );

const listTools = (app: App) =>
  app.request(paths.mcp, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Forwarded-For": "203.0.113.7",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

/** The writes per collection. */
const byCollection = (writes: string[]) =>
  writes.reduce<Record<string, number>>((counts, path) => {
    const [collection] = path.split("/");
    counts[collection] = (counts[collection] ?? 0) + 1;
    return counts;
  }, {});

const read = (store: DocumentStore, path: string) =>
  store.update<StoreDocument | undefined>(path, (doc) => ({ result: doc }));

/** An execution context, as the server passes one per request, that tells when the handler is done. */
function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: () => {},
      props: {},
    },
    async handlerResolved() {
      for (let i = 0; i < pending.length; i++) await pending[i];
    },
  };
}

describe("the store writes of one request", () => {
  it("a chat request with several model calls writes its daily quota and spend cap once to reserve and once to settle", async () => {
    const { store, writes } = countingStore();
    const model = createFakeModel([
      { toolCalls: [{ id: "toolu_0", name: "get_projects", input: {} }] },
      { toolCalls: [{ id: "toolu_1", name: "get_projects", input: {} }] },
      { text: "A portfolio site." },
    ]);
    const app = createApp(testAppDeps({ modelClient: model, ...createGuardrails(store, loadConfig({})) }));

    const res = await chat(app);
    await res.text();

    expect(res.status).toBe(200);
    expect(model.requests).toHaveLength(3);
    // No usage batch is waiting, so none is written.
    expect(byCollection(writes)).toEqual({ [dailySpendCollection]: 2, [spendCollection]: 2, [usageCollection]: 1 });
  });

  it("are exactly 5 for a chat request and 0 for an MCP request, plus the usage batch when one is due", async () => {
    const { store, writes } = countingStore();
    let now = Date.parse("2026-11-04T10:00:00Z");
    const usage = createUsageRecorder({ store, pricing, now: () => now });
    const app = createApp(
      testAppDeps({
        modelClient: createFakeModel([{ text: "Hi." }, { text: "Hi again." }]),
        ...createGuardrails(store, loadConfig({})),
        usage,
      }),
    );
    const writesOf = async (request: () => Response | Promise<Response>) => {
      const before = writes.length;
      const res = await request();
      await res.text();
      expect(res.status).toBe(200);
      return writes.length - before;
    };

    // A fresh instance has never written a batch, so the first one is due at once.
    expect(await writesOf(() => listTools(app))).toBe(1);
    expect(await writesOf(() => listTools(app))).toBe(0);
    expect(await writesOf(() => listTools(app))).toBe(0);
    expect(await writesOf(() => chat(app))).toBe(5);
    now += defaultFlushEveryMs;
    // The batch is due again: the next request writes it, a chat request too.
    expect(await writesOf(() => chat(app))).toBe(6);
    expect(await writesOf(() => listTools(app))).toBe(0);
  });
});

describe("a hold that expires unsettled", () => {
  // A request's worst case: one model call of 1000 output tokens, $0.02.
  const outputOnly = { inputUsdPerMTok: 0, outputUsdPerMTok: 20 };
  const chatLimits = { maxModelCalls: 1, maxTokens: 1000, maxRequestTokens: 1000 };

  it("counts as spent at its worst case, and its late settle doesn't charge it again", async () => {
    const { store, writes } = countingStore();
    let now = Date.parse("2026-11-04T10:00:00Z");
    const instance = (script: Parameters<typeof createFakeModel>[0]) =>
      createApp(
        testAppDeps({
          modelClient: createFakeModel(script),
          spendCap: createStoreSpendCap({ store, capUsd: 1, pricing: outputOnly, now: () => now }),
          dailyQuota: createStoreDailyQuota({ store, quotaUsd: 1, pricing: outputOnly, now: () => now }),
          chatLimits,
        }),
      );
    // An instance whose request never settles: the model call hangs, as if
    // the instance died mid-answer.
    const dying = instance([{ text: "Thinking it over", hang: true }]);
    const { ctx, handlerResolved } = executionContext();
    const visitor = new AbortController();
    const hanging = (await chat(dying, { signal: visitor.signal }, ctx)).body!.getReader();
    await hanging.read();

    // Past the reservation's TTL, another instance takes a chat request of
    // 10 output tokens ($0.0002).
    now += 16 * 60_000;
    const res = await chat(instance([{ text: "Hi.", usage: { inputTokens: 100, outputTokens: 10 } }]));
    await res.text();

    const dailyPath = writes.find((path) => path.startsWith(`${dailySpendCollection}/`))!;
    const charged = { spentUsd: 0.0202, holds: {} };
    expect(await read(store, spendPath(now))).toMatchObject(charged);
    expect(await read(store, dailyPath)).toMatchObject(charged);

    // The hung request ends after all, charged at the output cap: no more than
    // the worst case already charged, so nothing more.
    visitor.abort();
    await hanging.cancel();
    await handlerResolved();
    expect(await read(store, spendPath(now))).toMatchObject(charged);
    expect(await read(store, dailyPath)).toMatchObject(charged);
  });
});
