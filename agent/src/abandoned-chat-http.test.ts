// A chat the visitor abandons mid-answer is accounted for inside its request:
// once the request's handler resolves (its response and the work it hands to
// `waitUntil`), the cut-off model call is charged and the reservation settled.
// Nothing is left for CPU after the response.
import { describe, expect, it } from "vitest";
import { createApp, paths } from "./app";
import { createMemoryDocumentStore, type DocumentStore, type StoreDocument } from "./document-store";
import { createFakeModel } from "./fake-model";
import { createStoreSpendCap, spendPath } from "./spend-cap";
import { testAppDeps } from "./test-deps";
import { createUsageRecorder } from "./usage";

const origin = "https://albertocarbonell.dev";
const outputOnly = { inputUsdPerMTok: 0, outputUsdPerMTok: 20 };
// A request's worst case, and the conservative charge of its cut-off call: $0.02.
const chatLimits = { maxModelCalls: 1, maxTokens: 1000, maxRequestTokens: 1000 };

/** A memory store whose every update takes a while, as a real one does. */
function slowStore(delayMs = 20): DocumentStore {
  const inner = createMemoryDocumentStore();
  return {
    async update(path, change) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return inner.update(path, change);
    },
  };
}

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

describe("a chat the visitor abandons mid-answer", () => {
  it("is charged at its output cap and settled before its request's handler resolves, and counted as aborted", async () => {
    const store = slowStore();
    const usage = createUsageRecorder({ store, pricing: outputOnly });
    const app = createApp(
      testAppDeps({
        modelClient: createFakeModel([{ text: "Thinking it over", hang: true }]),
        spendCap: createStoreSpendCap({ store, capUsd: 1, pricing: outputOnly }),
        usage,
        chatLimits,
      }),
    );
    const { ctx, handlerResolved } = executionContext();
    const visitor = new AbortController();

    const res = await app.fetch(
      new Request(new URL(paths.chat, "http://agent.test"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ messages: [{ role: "user", content: "Who is Alberto?" }] }),
        signal: visitor.signal,
      }),
      {},
      ctx,
    );
    const body = res.body!.getReader();
    await body.read(); // The model call is under way.
    // The visitor closes the tab: the connection goes, and with it the response.
    visitor.abort();
    await body.cancel();
    await handlerResolved();

    expect(await read(store, spendPath(Date.now()))).toMatchObject({ spentUsd: 0.02, holds: {} });
    expect((await usage.stats()).current.chat.outcomes).toEqual({ aborted: 1 });
    await usage.close();
  });
});
