// The store-failure policy, over HTTP: with the shared store down, `/mcp` and
// `/stats` fail open and `/chat` fails closed (README, "Shared store").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchContactEmail } from "../../src/shared/mcp-contact";
import { createApp, httpErrorMessages, paths } from "./app";
import { errorMessages } from "./chat";
import { createGuardrails } from "./compose";
import { loadConfig } from "./config";
import type { DocumentStore } from "./document-store";
import { createFakeModel } from "./fake-model";
import { createFirestoreDocumentStore } from "./firestore";
import { hangingFetch } from "./firestore-fake";
import { listen, type RunningServer } from "./server";
import { testAppDeps } from "./test-deps";
import { createToolset, siteContent } from "./tools";

let server: RunningServer | undefined;

beforeEach(() => {
  // The policy logs each failure; keep the test output quiet.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

const contactEmail = "ada@example.com";
const origin = "https://albertocarbonell.dev";

/** A store whose every update fails, like Firestore unreachable. */
const brokenStore: DocumentStore = {
  update: async () => {
    throw new Error("store unreachable");
  },
};

/** The app with every guardrail on `store`, as production wires it. */
async function start(store: DocumentStore) {
  server = await listen(
    createApp(
      testAppDeps({
        toolset: createToolset({ ...siteContent, contactEmail }),
        modelClient: createFakeModel([{ text: "Hi." }]),
        ...createGuardrails(store, loadConfig({})),
      }),
    ),
    0,
  );
  return server.url;
}

describe("with the shared store down", () => {
  it("/mcp still answers get_contact (fails open)", async () => {
    const url = await start(brokenStore);
    expect(await fetchContactEmail(new URL(paths.mcp, url).href)).toBe(contactEmail);
  });

  it("/stats hides cleanly: 503 unavailable JSON, readable from any origin", async () => {
    const url = await start(brokenStore);
    const res = await fetch(new URL(paths.stats, url), { headers: { Origin: "https://elsewhere.example" } });

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({
      error: { code: "unavailable", message: httpErrorMessages.statsUnavailable },
    });
  });

  it("/chat fails closed: 503 unavailable JSON with CORS, without calling the model", async () => {
    const url = await start(brokenStore);
    const res = await fetch(new URL(paths.chat, url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ messages: [{ role: "user", content: "Who is Alberto?" }] }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await res.json()).toEqual({
      error: { code: "unavailable", message: errorMessages.unavailable },
    });
  });

  it("/chat fails closed when only the spend cap's store fails", async () => {
    const guardrails = createGuardrails(brokenStore, loadConfig({}));
    server = await listen(
      createApp(testAppDeps({ spendCap: guardrails.spendCap })),
      0,
    );
    const res = await fetch(new URL(paths.chat, server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ messages: [{ role: "user", content: "Who is Alberto?" }] }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect((await res.json()).error.code).toBe("unavailable");
  });
});

describe("with Firestore hanging", () => {
  // Each call gives up after 50 ms; a request makes at most a few in a row.
  const hangingStore = () =>
    createFirestoreDocumentStore({
      projectId: "acb-landing",
      emulatorHost: "localhost:8081",
      fetch: hangingFetch,
      timeoutMs: 50,
    });
  const deadlineMs = 1000;

  async function timed(request: Promise<Response>) {
    const started = performance.now();
    const res = await request;
    await res.text();
    return { status: res.status, ms: performance.now() - started };
  }

  it("every route answers within the timeout plus a margin, by its policy", async () => {
    const url = await start(hangingStore());

    const contact = performance.now();
    expect(await fetchContactEmail(new URL(paths.mcp, url).href)).toBe(contactEmail);
    expect(performance.now() - contact).toBeLessThan(deadlineMs);

    const stats = await timed(fetch(new URL(paths.stats, url)));
    expect(stats).toMatchObject({ status: 503 });
    expect(stats.ms).toBeLessThan(deadlineMs);

    const chat = await timed(
      fetch(new URL(paths.chat, url), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ messages: [{ role: "user", content: "Who is Alberto?" }] }),
      }),
    );
    expect(chat).toMatchObject({ status: 503 });
    expect(chat.ms).toBeLessThan(deadlineMs);
  });

  it("logs the failures with no client IP and no message content", async () => {
    const url = await start(hangingStore());
    const ip = "203.0.113.7";
    await timed(fetch(new URL(paths.stats, url), { headers: { "X-Forwarded-For": ip } }));
    await timed(
      fetch(new URL(paths.chat, url), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin, "X-Forwarded-For": ip },
        body: JSON.stringify({ messages: [{ role: "user", content: "Who is Alberto?" }] }),
      }),
    );

    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
    expect(logged).toMatch(/timed out/);
    expect(logged).not.toContain(ip);
    expect(logged).not.toContain("Who is Alberto?");
  });
});

describe("an error no route handled", () => {
  it("on /mcp is a JSON-RPC error with CORS, not a plain-text 500", async () => {
    const usage = testAppDeps().usage;
    server = await listen(
      createApp(
        testAppDeps({
          usage: { ...usage, recordMcp: () => Promise.reject(new Error("store unreachable")) },
        }),
      ),
      0,
    );
    const res = await fetch(new URL(paths.mcp, server.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Origin: "https://elsewhere.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, data: { code: "unavailable" } },
    });
  });
});
