// A minimal document store with atomic read-modify-write, the one thing the
// shared rate limits and spend cap need. Production backs it with Firestore
// (`firestore.ts`); the in-memory version serves local development and tests.
import { describeError, logEvent } from "./log";

export type StoreValue = null | boolean | number | string | Date | StoreDocument;
export type StoreDocument = { [field: string]: StoreValue };

/** What a change returns: the document to write (omit to write nothing) and a result. */
export type StoreChange<R> = { doc?: StoreDocument; result: R };

export interface DocumentStore {
  /**
   * Reads the document at `path` (`collection/id`), passes it to `change`
   * (`undefined` if it doesn't exist) and writes back the document `change`
   * returns, atomically: if another writer changes the document in between,
   * `change` runs again on the fresh copy. So `change` must be pure.
   */
  update<R>(path: string, change: (doc: StoreDocument | undefined) => StoreChange<R>): Promise<R>;
}

/**
 * In-memory store with the same optimistic concurrency as Firestore: each
 * update yields between its read and its write, and retries if another update
 * wrote in between. Per process, so not shared between instances.
 */
export function createMemoryDocumentStore(): DocumentStore {
  const docs = new Map<string, { doc: StoreDocument; version: number }>();

  return {
    async update(path, change) {
      for (;;) {
        const read = docs.get(path);
        const { doc, result } = change(read && structuredClone(read.doc));
        // Let concurrent updates interleave, as they would against a real store.
        await Promise.resolve();
        if (docs.get(path)?.version !== read?.version) continue;
        if (doc) docs.set(path, { doc: structuredClone(doc), version: (read?.version ?? 0) + 1 });
        return result;
      }
    },
  };
}

/**
 * `store` with its health logged once per change: `store_unavailable` when an
 * update fails after the last one succeeded (or at the first), and
 * `store_recovered` when one succeeds after a failure. Per instance: the
 * store can't record its own outage. Each failure is still thrown, and logged
 * as `store_error` by whoever called.
 */
export function withStoreHealthEvents(store: DocumentStore): DocumentStore {
  let healthy = true;
  return {
    async update(path, change) {
      // Collection only: a document id can hold a client IP.
      const [collection] = path.split("/");
      try {
        const result = await store.update(path, change);
        if (!healthy) {
          healthy = true;
          logEvent("INFO", "store_recovered", "Shared store: working again", { collection });
        }
        return result;
      } catch (error) {
        if (healthy) {
          healthy = false;
          logEvent("ERROR", "store_unavailable", "Shared store: updates are failing", {
            collection,
            error: describeError(error),
          });
        }
        throw error;
      }
    },
  };
}
