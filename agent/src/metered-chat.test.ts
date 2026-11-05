import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatAgent, type ChatRunEvent } from "./chat";
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { createFakeModel, type ScriptedResponse } from "./fake-model";
import { meteredChat } from "./metered-chat";
import { createStoreSpendCap, spendCollection } from "./spend-cap";
import { createToolset } from "./tools";
import { createUsageRecorder } from "./usage";

const pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };
const question = [{ role: "user" as const, content: "Who is Alberto?" }];

/** A memory store whose spend writes fail once `failSpend` is set. */
function flakyStore() {
  const store = createMemoryDocumentStore();
  const flaky = {
    failSpend: false,
    update: ((path, change) => {
      if (flaky.failSpend && path.startsWith(`${spendCollection}/`)) {
        return Promise.reject(new Error("store unavailable"));
      }
      return store.update(path, change);
    }) as DocumentStore["update"],
  };
  return flaky;
}

/** Runs one metered chat over memory adapters and a fake model. */
async function run(script: ScriptedResponse[], { failSettle = false } = {}) {
  const store = flakyStore();
  const spendCap = createStoreSpendCap({ store, budgetUsd: 10, pricing });
  const usage = createUsageRecorder({ store: createMemoryDocumentStore(), pricing });
  const agent = createChatAgent({ model: createFakeModel(script), toolset: createToolset() });
  const status = await spendCap.reserve({ inputTokens: 0, outputTokens: 0 });
  if (status.exhausted) throw new Error("budget exhausted");
  const reservation = failSettle
    ? {
        record: status.reservation.record,
        settle: () => {
          store.failSpend = true;
          return status.reservation.settle();
        },
      }
    : status.reservation;

  const events: ChatRunEvent[] = [];
  for await (const event of meteredChat(question, {
    agent,
    reservation,
    usage,
    startedAt: performance.now(),
  })) {
    events.push(event);
  }
  return { events, stats: (await usage.stats()).current.chat };
}

afterEach(() => vi.restoreAllMocks());

describe("meteredChat", () => {
  it("yields the chat's events and records the request's outcome, tokens and cost", async () => {
    const script = [
      { text: "A backend engineer.", usage: { inputTokens: 1000, outputTokens: 100 } },
    ];
    const { events, stats } = await run(script);

    const unmetered = createChatAgent({ model: createFakeModel(script), toolset: createToolset() });
    const expected: ChatRunEvent[] = [];
    for await (const event of unmetered.run(question)) expected.push(event);
    expect(events).toEqual(expected);
    expect(stats).toMatchObject({
      requests: 1,
      outcomes: { end_turn: 1 },
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: 0.006,
    });
    expect(stats.latency.p50Ms).not.toBeNull();
    expect(stats.firstText.p50Ms).not.toBeNull();
  });

  it("still records the request's usage when settling the reservation fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const { stats } = await run(
      [{ text: "A backend engineer.", usage: { inputTokens: 1000, outputTokens: 100 } }],
      { failSettle: true },
    );

    expect(stats).toMatchObject({ requests: 1, outcomes: { end_turn: 1 }, inputTokens: 1000 });
    expect(logged).toHaveBeenCalled();
  });
});
