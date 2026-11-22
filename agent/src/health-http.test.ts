// The health checks, over HTTP: `/health` is liveness only, and
// `/health?deep=1` reads the store and checks the production config, under a
// rate limit (docs/chat-contract.md, "Health check").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, httpErrorMessages, paths } from "./app";
import { loadConfig } from "./config";
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { createDeepHealthCheck, deepHealthChecksPerMinute } from "./health";
import { listen, type RunningServer } from "./server";
import { testAppDeps, testSigningKey } from "./test-deps";

let server: RunningServer | undefined;

beforeEach(() => {
  // A failing check logs why; keep the test output quiet.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

/** A store whose every update fails, like Firestore unreachable. */
const brokenStore: DocumentStore = {
  update: async () => {
    throw new Error("store unreachable");
  },
};

/** The secrets production sets, as placeholders. */
const productionEnv = {
  ANTHROPIC_API_KEY: "sk-test-placeholder",
  CONTACT_EMAIL: "ada@example.com",
  ANSWER_SIGNING_KEY: testSigningKey,
};

async function start({
  store = createMemoryDocumentStore(),
  env = productionEnv,
}: { store?: DocumentStore; env?: Record<string, string> } = {}) {
  server = await listen(
    createApp(testAppDeps({ deepHealth: createDeepHealthCheck({ store, config: loadConfig(env) }) })),
    0,
  );
  return server.url;
}

const deepHealthUrl = (url: string) => new URL(`${paths.health}?deep=1`, url);

const unavailable = {
  error: { code: "unavailable", message: expect.any(String) },
};

describe("/health?deep=1", () => {
  it("answers 200 ok when the store answers and the config is complete", async () => {
    const url = await start();
    const res = await fetch(deepHealthUrl(url));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers 503 unavailable JSON when the store fails", async () => {
    const url = await start({ store: brokenStore });
    const res = await fetch(deepHealthUrl(url));

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual(unavailable);
  });

  it.each(Object.keys(productionEnv))("answers 503 when %s is missing", async (name) => {
    const env = Object.fromEntries(Object.entries(productionEnv).filter(([key]) => key !== name));
    const url = await start({ env });
    const res = await fetch(deepHealthUrl(url));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(unavailable);
  });

  it(`is rate-limited to ${deepHealthChecksPerMinute} a minute, from any client`, async () => {
    const url = await start();
    for (let i = 0; i < deepHealthChecksPerMinute; i++) {
      expect((await fetch(deepHealthUrl(url))).status).toBe(200);
    }
    const refused = await fetch(deepHealthUrl(url));

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toEqual({
      error: { code: "rate_limited", message: httpErrorMessages.rateLimited },
    });
  });
});

describe("/health", () => {
  it("stays liveness only: 200 ok with the store down, past the deep check's limit", async () => {
    const url = await start({ store: brokenStore });
    for (let i = 0; i <= deepHealthChecksPerMinute; i++) await fetch(deepHealthUrl(url));
    const res = await fetch(new URL(paths.health, url));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
