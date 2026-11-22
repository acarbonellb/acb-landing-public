// The `DocumentStore` contract: one suite, run against every implementation.
// The Firestore store runs on the hand-written REST fake always, and on the
// real Firestore emulator when `FIRESTORE_EMULATOR_HOST` points at one (CI
// starts it; docs/development.md says how to run it locally). So the fake is
// held to what the emulator does, and the concurrency guarantee is checked
// against a real Firestore, not only against a reading of its preconditions.
import { describe, expect, it } from "vitest";
import { createMemoryDocumentStore, type DocumentStore } from "./document-store";
import { createFirestoreDocumentStore } from "./firestore";
import { fakeFirestore, root } from "./firestore-fake";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

/** Each call returns a store with no documents in it. */
type Implementation = { name: string; fresh: () => DocumentStore; skip?: boolean };

// Enough tries that a burst of racing writers in one test always lands.
const maxAttempts = 50;

const implementations: Implementation[] = [
  { name: "memory", fresh: createMemoryDocumentStore },
  {
    name: "Firestore on the REST fake",
    fresh: () =>
      createFirestoreDocumentStore({
        projectId: "acb-landing",
        emulatorHost: "localhost:8081",
        fetch: fakeFirestore().fetch,
        maxAttempts,
      }),
  },
  {
    name: "Firestore on the emulator",
    skip: !emulatorHost,
    // A project of its own per store: the emulator keeps each one apart.
    fresh: () =>
      createFirestoreDocumentStore({
        projectId: `contract-${crypto.randomUUID()}`,
        emulatorHost,
        maxAttempts,
      }),
  },
];

describe.each(implementations)("DocumentStore contract: $name", ({ fresh, skip }) => {
  const test = it.skipIf(skip);

  test("passes undefined for a document that doesn't exist", async () => {
    const store = fresh();
    expect(await store.update("c/missing", (doc) => ({ result: doc }))).toBeUndefined();
  });

  test("reads back every kind of value it wrote", async () => {
    const store = fresh();
    const doc = {
      count: 3,
      zero: 0,
      negative: -2,
      usd: 0.25,
      label: "a",
      empty: "",
      on: true,
      off: false,
      none: null,
      expireAt: new Date("2026-11-04T10:00:00.000Z"),
      holds: { h1: { usd: 1.5, at: new Date("2026-11-04T10:00:00.123Z") } },
      noHolds: {},
    };
    await store.update("counters/chat:<visitor>", () => ({ doc, result: undefined }));
    expect(await store.update("counters/chat:<visitor>", (current) => ({ result: current }))).toEqual(doc);
  });

  test("replaces the whole document on each write", async () => {
    const store = fresh();
    await store.update("c/x", () => ({ doc: { a: 1, b: { c: 2 } }, result: 0 }));
    await store.update("c/x", () => ({ doc: { b: { d: 3 } }, result: 0 }));
    expect(await store.update("c/x", (doc) => ({ result: doc }))).toEqual({ b: { d: 3 } });
  });

  test("returns the change's result, and writes nothing when it returns no document", async () => {
    const store = fresh();
    expect(await store.update("spend/2026-11", () => ({ result: "no" }))).toBe("no");
    expect(await store.update("spend/2026-11", (doc) => ({ result: doc }))).toBeUndefined();
  });

  test("keeps documents whose ids differ only in characters a URL escapes apart", async () => {
    const store = fresh();
    const ids = ["chat:2001:db8::1", "chat:2001%3Adb8%3A%3A1", "chat:a b", "chat:a+b", "chat:a?b#c"];
    for (const [i, id] of ids.entries()) {
      await store.update(`counters/${id}`, () => ({ doc: { i }, result: 0 }));
    }
    for (const [i, id] of ids.entries()) {
      expect(await store.update(`counters/${id}`, (doc) => ({ result: doc }))).toEqual({ i });
    }
  });

  // The racers retry with backoff, so on the emulator this takes seconds.
  test("never loses a write when updates race for the same document", { timeout: 60_000 }, async () => {
    const store = fresh();
    const racers = 20;
    const seen = await Promise.all(
      Array.from({ length: racers }, () =>
        store.update("counters/chat:race", (doc) => {
          const count = Number(doc?.count ?? 0) + 1;
          return { doc: { count }, result: count };
        }),
      ),
    );
    expect(await store.update("counters/chat:race", (doc) => ({ result: doc }))).toEqual({
      count: racers,
    });
    // Each update saw a different count: none ran its change on a stale copy and won.
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: racers }, (_, i) => i + 1));
  });

  test("never lets two racing creates both win", { timeout: 60_000 }, async () => {
    const store = fresh();
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.update("spend/race", (doc) => (doc ? { result: false } : { doc: { by: i }, result: true })),
      ),
    );
    expect(created.filter(Boolean)).toHaveLength(1);
  });
});

// Below the store: the fake answers the REST calls the store makes the way the
// emulator does, so tests that read the fake's documents or play another
// writer through it see what a real Firestore would show.
type RestBackend = { name: string; fresh: () => { root: string; fetch: typeof fetch }; skip?: boolean };

const restBackends: RestBackend[] = [
  { name: "the REST fake", fresh: () => ({ root, fetch: fakeFirestore().fetch as typeof fetch }) },
  {
    name: "the emulator",
    skip: !emulatorHost,
    fresh: () => ({
      root: `projects/contract-${crypto.randomUUID()}/databases/(default)/documents`,
      fetch,
    }),
  },
];

describe.each(restBackends)("Firestore REST behaviour: $name", ({ fresh, skip }) => {
  const test = it.skipIf(skip);

  function client() {
    const { root: documents, fetch: fetchImpl } = fresh();
    const base = `http://${emulatorHost ?? "localhost:8081"}/v1/${documents}`;
    const headers = { Authorization: "Bearer owner", "Content-Type": "application/json" };
    return {
      async get(id: string) {
        const res = await fetchImpl(`${base}/c/${id}`, { headers });
        return { status: res.status, body: await res.json() };
      },
      async commit(id: string, fields: object, currentDocument: object) {
        const res = await fetchImpl(`${base}:commit`, {
          method: "POST",
          headers,
          body: JSON.stringify({ writes: [{ update: { name: `${documents}/c/${id}`, fields }, currentDocument }] }),
        });
        return { status: res.status, body: await res.json() };
      },
    };
  }
  const timestamp = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);

  test("answers a missing document with 404 NOT_FOUND", async () => {
    const { status, body } = await client().get("x");
    expect(status).toBe(404);
    expect(body.error.status).toBe("NOT_FOUND");
  });

  test("answers a commit with the write's update time, which a read then shows", async () => {
    const rest = client();
    const commit = await rest.commit("x", { n: { integerValue: "1" } }, { exists: false });
    expect(commit).toEqual({
      status: 200,
      body: { writeResults: [{ updateTime: timestamp }], commitTime: timestamp },
    });
    const read = await rest.get("x");
    expect(read.body.updateTime).toBe(commit.body.writeResults[0].updateTime);
    expect(read.body.createTime).toBe(read.body.updateTime);
  });

  test("keeps the create time and moves the update time on a later write", async () => {
    const rest = client();
    await rest.commit("x", { n: { integerValue: "1" } }, { exists: false });
    const first = (await rest.get("x")).body;
    await rest.commit("x", { n: { integerValue: "2" } }, { updateTime: first.updateTime });
    const second = (await rest.get("x")).body;
    expect(second.createTime).toBe(first.createTime);
    expect(second.updateTime > first.updateTime).toBe(true);
  });

  test("keeps the update time when a write changes nothing, so a writer that read it still wins", async () => {
    const rest = client();
    await rest.commit("x", { n: { integerValue: "1" }, m: { mapValue: { fields: {} } } }, { exists: false });
    const first = (await rest.get("x")).body;
    const same = await rest.commit("x", { m: { mapValue: {} }, n: { integerValue: "1" } }, {
      updateTime: first.updateTime,
    });
    expect(same.body.writeResults[0].updateTime).toBe(first.updateTime);
    expect((await rest.get("x")).body.updateTime).toBe(first.updateTime);
    const next = await rest.commit("x", { n: { integerValue: "2" } }, { updateTime: first.updateTime });
    expect(next.status).toBe(200);
  });

  test("leaves out empty fields and empty maps' fields when reading back", async () => {
    const rest = client();
    await rest.commit("empty", {}, { exists: false });
    expect((await rest.get("empty")).body).not.toHaveProperty("fields");

    await rest.commit("x", { m: { mapValue: { fields: {} } }, none: { nullValue: null } }, { exists: false });
    expect((await rest.get("x")).body.fields).toEqual({ m: { mapValue: {} }, none: { nullValue: null } });
  });

  test("rejects a create over an existing document with 409 ALREADY_EXISTS", async () => {
    const rest = client();
    await rest.commit("x", {}, { exists: false });
    const { status, body } = await rest.commit("x", {}, { exists: false });
    expect([status, body.error.status]).toEqual([409, "ALREADY_EXISTS"]);
  });

  test("rejects a write on a stale or missing document with 400 FAILED_PRECONDITION", async () => {
    const rest = client();
    await rest.commit("x", {}, { exists: false });
    const stale = await rest.commit("x", {}, { updateTime: "2020-01-01T00:00:00.000001Z" });
    expect([stale.status, stale.body.error.status]).toEqual([400, "FAILED_PRECONDITION"]);
    const missing = await rest.commit("y", {}, { updateTime: "2020-01-01T00:00:00.000001Z" });
    expect([missing.status, missing.body.error.status]).toEqual([400, "FAILED_PRECONDITION"]);
  });
});
