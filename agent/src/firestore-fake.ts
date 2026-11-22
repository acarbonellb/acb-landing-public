// A fake of the Firestore REST API, for tests of the Firestore store and of
// what the guardrails and usage stats write through it. Never calls a real API.

export const root = "projects/acb-landing/databases/(default)/documents";

type Fields = Record<string, unknown>;

/** `fields` as Firestore stores them: a map with no fields loses its empty `fields`. */
function normalize(fields: Fields): Fields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      const map = (value as { mapValue?: { fields?: Fields } }).mapValue;
      if (!map) return [key, value];
      const inner = normalize(map.fields ?? {});
      return [key, { mapValue: Object.keys(inner).length ? { fields: inner } : {} }];
    }),
  );
}

/** A key-order-independent form of `fields`, to tell whether a write changes a document. */
const canonical = (value: unknown): string =>
  value && typeof value === "object"
    ? `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical((value as Fields)[k])}`)
        .join(",")}}`
    : JSON.stringify(value);

/**
 * Just enough of the Firestore REST API: get and commit of single documents,
 * with the `exists` / `updateTime` preconditions, answered as the Firestore
 * emulator answers them (the contract suite in `document-store.contract.test.ts`
 * checks it). As in Firestore, a write that changes nothing keeps the
 * document's update time. `beforeCommit` runs before each commit, to play
 * another writer.
 */
export function fakeFirestore() {
  const docs = new Map<string, { fields: Fields; createTime: string; updateTime: string }>();
  let clock = 0;
  const tick = () => `2026-11-04T00:00:00.${String(++clock).padStart(6, "0")}Z`;
  const requests: { method: string; url: string; authorization: string | null }[] = [];
  const fake = {
    docs,
    requests,
    beforeCommit: undefined as (() => void) | undefined,
    /** Writes `fields` to the document `name`, as another writer would; returns its update time. */
    write(name: string, fields: Fields): string {
      const current = docs.get(name);
      const stored = normalize(fields);
      if (current && canonical(current.fields) === canonical(stored)) return current.updateTime;
      const updateTime = tick();
      docs.set(name, { fields: stored, createTime: current?.createTime ?? updateTime, updateTime });
      return updateTime;
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
        const { fields, createTime, updateTime } = doc;
        // Firestore leaves `fields` out of a document that has none.
        return json(200, {
          name: path,
          ...(Object.keys(fields).length ? { fields } : {}),
          createTime,
          updateTime,
        });
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
        const clockBefore = clock;
        const updateTime = fake.write(write.update.name, write.update.fields ?? {});
        // The commit's own time: the write's, or a fresh one if it changed nothing.
        const commitTime = clock > clockBefore ? updateTime : tick();
        return json(200, { writeResults: [{ updateTime }], commitTime });
      }
      return json(500, { error: { code: 500, status: "INTERNAL" } });
    },
  };
  return fake;
}

/**
 * A `fetch` that never answers, like a Firestore that hangs: it settles only
 * when its request is aborted, rejecting with the abort reason.
 */
export const hangingFetch = (_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
