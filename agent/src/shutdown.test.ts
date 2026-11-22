import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createApp, paths } from "./app";
import { createMemoryDocumentStore } from "./document-store";
import { listen } from "./server";
import { closeOnSignals } from "./shutdown";
import { testAppDeps } from "./test-deps";
import { createUsageRecorder } from "./usage";

const pricing = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };

const listTools = (url: string) =>
  fetch(new URL(paths.mcp, url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("on SIGTERM", () => {
  it("writes the pending usage, closes the server and exits", async () => {
    const store = createMemoryDocumentStore();
    const usage = createUsageRecorder({ store, pricing, flushEveryMs: 60_000 });
    const server = await listen(createApp(testAppDeps({ usage })), 0);
    const signals = new EventEmitter();
    const exited = new Promise<number>((resolve) => closeOnSignals(signals, { server, usage, exit: resolve }));

    // The first is written at once; the others wait for a due batch.
    for (let i = 0; i < 3; i++) expect((await listTools(server.url)).status).toBe(200);
    signals.emit("SIGTERM");

    expect(await exited).toBe(0);
    const another = createUsageRecorder({ store, pricing });
    expect((await another.stats()).current.mcp.requests).toBe(3);
    await expect(listTools(server.url)).rejects.toThrow();
  });
});
