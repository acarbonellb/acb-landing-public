// A minimal document store with atomic read-modify-write, the one thing the
// shared rate limits and spend cap need. Production backs it with Firestore
// (`firestore.ts`); the in-memory version serves local development and tests.

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
