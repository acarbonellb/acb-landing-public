// `DocumentStore` on Firestore, through its REST API with plain `fetch`, so
// the agent stays one self-contained bundle with no Google SDK (see ADR 0003).
//
// Each update reads the document, then commits the change with a
// precondition: the document's `updateTime` as read, or that it doesn't exist
// yet. If another writer got there first the commit fails and the update
// starts over, so concurrent updates never overwrite each other.
//
// Auth: on Cloud Run, an access token for the service's own service account
// from the metadata server. Against the Firestore emulator, none is needed.
import type { DocumentStore, StoreDocument, StoreValue } from "./document-store";

export type FirestoreOptions = {
  projectId: string;
  /** Defaults to `(default)`, the database the free tier applies to. */
  databaseId?: string;
  /** `host:port` of the Firestore emulator; unset in production. */
  emulatorHost?: string;
  fetch?: typeof fetch;
  /** Injectable clock (ms since epoch), for the token's expiry. */
  now?: () => number;
  /** Tries per update before giving up on conflicts. */
  maxAttempts?: number;
  /** How long one REST call (or token request) may take before it fails. */
  timeoutMs?: number;
};

/** Default `timeoutMs`: a few seconds, well under any request's patience. */
export const defaultFirestoreTimeoutMs = 3000;

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { mapValue: { fields?: FirestoreFields } };
type FirestoreFields = Record<string, FirestoreValue>;

function encode(value: StoreValue): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  return { mapValue: { fields: encodeFields(value) } };
}

const encodeFields = (doc: StoreDocument): FirestoreFields =>
  Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, encode(v)]));

function decode(value: FirestoreValue): StoreValue {
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return new Date(value.timestampValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
  return null;
}

const decodeFields = (fields: FirestoreFields): StoreDocument =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decode(v)]));

const metadataTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Commit failures that mean "someone else wrote first": retry. */
const conflictStatuses = new Set(["ABORTED", "ALREADY_EXISTS", "FAILED_PRECONDITION"]);

/** Encodes each segment of a `a/b/c` path for a URL. */
const urlPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Waits a random 10–50 ms × attempt, so writers racing for a document spread out. */
const backoff = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, attempt * (10 + Math.random() * 40)));

export function createFirestoreDocumentStore(options: FirestoreOptions): DocumentStore {
  const {
    projectId,
    databaseId = "(default)",
    emulatorHost,
    fetch: fetchImpl = fetch,
    now = Date.now,
    maxAttempts = 10,
    timeoutMs = defaultFirestoreTimeoutMs,
  } = options;
  const documents = `projects/${projectId}/databases/${databaseId}/documents`;
  const base = emulatorHost
    ? `http://${emulatorHost}/v1`
    : "https://firestore.googleapis.com/v1";
  const documentsUrl = `${base}/${urlPath(documents)}`;

  let token: { value: string; expiresAt: number } | undefined;

  /** `fetch` that fails with "timed out" once `timeoutMs` pass without an answer. */
  async function timedFetch(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error(`Firestore ${what} timed out after ${timeoutMs} ms`);
      }
      throw error;
    }
  }

  async function authorization(): Promise<string> {
    // The emulator accepts any token; "owner" bypasses its security rules.
    if (emulatorHost) return "Bearer owner";
    if (!token || now() >= token.expiresAt) {
      const res = await timedFetch(
        metadataTokenUrl,
        { headers: { "Metadata-Flavor": "Google" } },
        "token request",
      );
      if (!res.ok) throw new Error(`Metadata server token request failed: ${res.status}`);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      // Refreshed a minute early, so a token never expires mid-request.
      token = { value: body.access_token, expiresAt: now() + (body.expires_in - 60) * 1000 };
    }
    return `Bearer ${token.value}`;
  }

  async function call(url: string, what: string, init: RequestInit = {}) {
    const headers = { Authorization: await authorization(), "Content-Type": "application/json" };
    return timedFetch(url, { ...init, headers }, what);
  }

  /**
   * The error for a failed call: its HTTP and Firestore status, not its body,
   * which can echo the document name (and so a client IP).
   */
  async function failure(res: Response, what: string): Promise<Error> {
    const status = await errorStatus(res);
    return new Error(`Firestore ${what} failed: ${res.status} ${status ?? ""}`.trim());
  }

  async function errorStatus(res: Response): Promise<string | undefined> {
    try {
      return ((await res.clone().json()) as { error?: { status?: string } }).error?.status;
    } catch {
      return undefined;
    }
  }

  return {
    async update(path, change) {
      const url = `${documentsUrl}/${urlPath(path)}`;
      // Errors name the collection only: a document id can hold a client IP.
      const [collection] = path.split("/");
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await call(url, `read in ${collection}`);
        if (!res.ok && res.status !== 404) throw await failure(res, `read in ${collection}`);
        const current =
          res.status === 404
            ? undefined
            : ((await res.json()) as { fields?: FirestoreFields; updateTime: string });

        const { doc, result } = change(current && decodeFields(current.fields ?? {}));
        if (!doc) return result;

        const commit = await call(`${documentsUrl}:commit`, `commit in ${collection}`, {
          method: "POST",
          body: JSON.stringify({
            writes: [
              {
                update: { name: `${documents}/${path}`, fields: encodeFields(doc) },
                currentDocument: current ? { updateTime: current.updateTime } : { exists: false },
              },
            ],
          }),
        });
        if (commit.ok) return result;
        const status = await errorStatus(commit);
        if (!status || !conflictStatuses.has(status)) throw await failure(commit, `commit in ${collection}`);
        if (attempt < maxAttempts) await backoff(attempt);
      }
      throw new Error(`Firestore update in ${collection} gave up after ${maxAttempts} conflicts`);
    },
  };
}
