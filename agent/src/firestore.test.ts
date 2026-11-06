import { describe, expect, it, vi } from "vitest";
import { createFirestoreDocumentStore } from "./firestore";
import { fakeFirestore, hangingFetch, root } from "./firestore-fake";

const emulator = (fake: ReturnType<typeof fakeFirestore>) =>
  createFirestoreDocumentStore({
    projectId: "acb-landing",
    emulatorHost: "localhost:8081",
    fetch: fake.fetch,
  });

describe("createFirestoreDocumentStore", () => {
  it("creates a document, then reads back every kind of value it wrote", async () => {
    const fake = fakeFirestore();
    const store = emulator(fake);
    const doc = {
      count: 3,
      usd: 0.25,
      label: "a",
      on: true,
      none: null,
      expireAt: new Date("2026-11-04T10:00:00.000Z"),
      holds: { h1: { usd: 1.5 } },
    };
    await store.update("rateLimits/chat:1.2.3.4", () => ({ doc, result: undefined }));

    const read = await store.update("rateLimits/chat:1.2.3.4", (current) => ({ result: current }));
    expect(read).toEqual(doc);
    expect(fake.docs.has(`${root}/rateLimits/chat:1.2.3.4`)).toBe(true);
  });

  it("encodes document ids in the URL", async () => {
    const fake = fakeFirestore();
    const store = emulator(fake);
    await store.update("rateLimits/chat:2001%3Adb8%3A%3A1", () => ({ doc: { count: 1 }, result: 0 }));
    expect(fake.requests[0].url).toBe(
      `http://localhost:8081/v1/${root}/rateLimits/chat%3A2001%253Adb8%253A%253A1`,
    );
    expect(fake.docs.has(`${root}/rateLimits/chat:2001%3Adb8%3A%3A1`)).toBe(true);
  });

  it("writes nothing when the change returns no document", async () => {
    const fake = fakeFirestore();
    const result = await emulator(fake).update("spend/2026-11", () => ({ result: "no" }));
    expect(result).toBe("no");
    expect(fake.requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("re-runs the change on the fresh document when another writer got there first", async () => {
    const fake = fakeFirestore();
    const store = emulator(fake);
    const increment = (doc: { [k: string]: unknown } | undefined) => ({
      doc: { count: Number(doc?.count ?? 0) + 1 },
      result: undefined,
    });

    // Another writer creates the document between our read and our commit...
    fake.beforeCommit = () => {
      fake.beforeCommit = undefined;
      fake.write(`${root}/c/x`, { count: { integerValue: "10" } });
    };
    await store.update("c/x", increment);
    // ...and changes it again before our next commit.
    fake.beforeCommit = () => {
      fake.beforeCommit = undefined;
      fake.write(`${root}/c/x`, { count: { integerValue: "20" } });
    };
    await store.update("c/x", increment);

    expect(await store.update("c/x", (doc) => ({ result: doc }))).toEqual({ count: 21 });
  });

  it("gives up after too many conflicts, and reports other errors", async () => {
    const fake = fakeFirestore();
    const store = createFirestoreDocumentStore({
      projectId: "acb-landing",
      emulatorHost: "localhost:8081",
      fetch: fake.fetch,
      maxAttempts: 3,
    });
    fake.beforeCommit = () => fake.write(`${root}/c/x`, {});
    await expect(store.update("c/x", () => ({ doc: {}, result: 0 }))).rejects.toThrow(/after 3 conflicts/);

    await expect(
      createFirestoreDocumentStore({
        projectId: "acb-landing",
        emulatorHost: "localhost:8081",
        fetch: async () => new Response("{}", { status: 503 }),
      }).update("c/x", () => ({ result: 0 })),
    ).rejects.toThrow(/503/);
  });

  it("on Cloud Run, authenticates with the metadata server's token and reuses it until it expires", async () => {
    const fake = fakeFirestore();
    let tokenRequests = 0;
    let now = 0;
    const store = createFirestoreDocumentStore({
      projectId: "acb-landing",
      now: () => now,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.startsWith("http://metadata.google.internal/")) {
          expect(new Headers(init?.headers).get("metadata-flavor")).toBe("Google");
          tokenRequests++;
          return Response.json({ access_token: `token-${tokenRequests}`, expires_in: 3600 });
        }
        expect(url.startsWith("https://firestore.googleapis.com/v1/")).toBe(true);
        return fake.fetch(input, init);
      },
    });

    await store.update("c/x", () => ({ result: 0 }));
    await store.update("c/x", () => ({ result: 0 }));
    expect(tokenRequests).toBe(1);
    now = 3600_000;
    await store.update("c/x", () => ({ result: 0 }));
    expect(fake.requests.map((r) => r.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-1",
      "Bearer token-2",
    ]);
  });

  describe("when Firestore hangs", () => {
    it("gives up on a call after the timeout", async () => {
      const store = createFirestoreDocumentStore({
        projectId: "acb-landing",
        emulatorHost: "localhost:8081",
        fetch: hangingFetch,
        timeoutMs: 20,
      });
      const started = performance.now();
      await expect(store.update("c/x", () => ({ result: 0 }))).rejects.toThrow(/timed out/);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it("gives up on the metadata server's token after the timeout too", async () => {
      const store = createFirestoreDocumentStore({
        projectId: "acb-landing",
        fetch: hangingFetch,
        timeoutMs: 20,
      });
      await expect(store.update("c/x", () => ({ result: 0 }))).rejects.toThrow(/timed out/);
    });

    it("defaults to a timeout of a few seconds", async () => {
      vi.useFakeTimers();
      try {
        const store = createFirestoreDocumentStore({
          projectId: "acb-landing",
          emulatorHost: "localhost:8081",
          fetch: hangingFetch,
        });
        const settled = expect(store.update("c/x", () => ({ result: 0 }))).rejects.toThrow(
          /timed out/,
        );
        await vi.advanceTimersByTimeAsync(5000);
        await settled;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("names only the collection in its errors, never the document id (it may hold a client IP)", async () => {
    const store = createFirestoreDocumentStore({
      projectId: "acb-landing",
      emulatorHost: "localhost:8081",
      fetch: async () =>
        Response.json(
          { error: { status: "INTERNAL", message: "rateLimits/chat:203.0.113.7" } },
          { status: 500 },
        ),
    });
    const error = await store
      .update("rateLimits/chat:203.0.113.7", () => ({ result: 0 }))
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/rateLimits/);
    expect(String(error)).not.toMatch(/203\.0\.113\.7/);
  });
});
