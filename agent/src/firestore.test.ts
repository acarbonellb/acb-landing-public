import { describe, expect, it } from "vitest";
import { createFirestoreDocumentStore } from "./firestore";

const root = "projects/acb-landing/databases/(default)/documents";

/**
 * Just enough of the Firestore REST API: get and commit of single documents,
 * with the `exists` / `updateTime` preconditions. `beforeCommit` runs before
 * each commit, to play another writer.
 */
function fakeFirestore() {
  const docs = new Map<string, { fields: unknown; updateTime: string }>();
  let clock = 0;
  const requests: { method: string; url: string; authorization: string | null }[] = [];
  const fake = {
    docs,
    requests,
    beforeCommit: undefined as (() => void) | undefined,
    write(name: string, fields: unknown) {
      docs.set(name, { fields, updateTime: `2026-11-04T00:00:00.${String(++clock).padStart(6, "0")}Z` });
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({
        method,
        url: url.href,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      const path = decodeURIComponent(url.pathname).replace(/^\/v1\//, "");

      if (method === "GET") {
        const doc = docs.get(path);
        if (!doc) return json(404, { error: { code: 404, status: "NOT_FOUND" } });
        return json(200, { name: path, ...doc });
      }
      if (method === "POST" && path === `${root}:commit`) {
        fake.beforeCommit?.();
        const [write] = JSON.parse(String(init?.body)).writes;
        const current = docs.get(write.update.name);
        const pre = write.currentDocument;
        if (pre.exists === false && current) {
          return json(409, { error: { code: 409, status: "ALREADY_EXISTS" } });
        }
        if (pre.updateTime && pre.updateTime !== current?.updateTime) {
          return json(400, { error: { code: 400, status: "FAILED_PRECONDITION" } });
        }
        fake.write(write.update.name, write.update.fields);
        return json(200, { writeResults: [{}] });
      }
      return json(500, { error: { code: 500, status: "INTERNAL" } });
    },
  };
  return fake;
}

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
});
