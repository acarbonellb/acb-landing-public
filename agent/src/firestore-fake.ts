// A fake of the Firestore REST API, for tests of the Firestore store and of
// what the guardrails and usage stats write through it. Never calls a real API.

export const root = "projects/acb-landing/databases/(default)/documents";

/**
 * Just enough of the Firestore REST API: get and commit of single documents,
 * with the `exists` / `updateTime` preconditions. `beforeCommit` runs before
 * each commit, to play another writer.
 */
export function fakeFirestore() {
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

/**
 * A `fetch` that never answers, like a Firestore that hangs: it settles only
 * when its request is aborted, rejecting with the abort reason.
 */
export const hangingFetch = (_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
