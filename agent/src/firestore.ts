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
};

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

export function createFirestoreDocumentStore(options: FirestoreOptions): DocumentStore {
  const {
    projectId,
    databaseId = "(default)",
    emulatorHost,
    fetch: fetchImpl = fetch,
    now = Date.now,
    maxAttempts = 10,
  } = options;
  const documents = `projects/${projectId}/databases/${databaseId}/documents`;
  const base = emulatorHost
    ? `http://${emulatorHost}/v1`
    : "https://firestore.googleapis.com/v1";
  const documentsUrl = `${base}/${documents.split("/").map(encodeURIComponent).join("/")}`;

  let token: { value: string; expiresAt: number } | undefined;

  async function authorization(): Promise<string> {
    // The emulator accepts any token; "owner" bypasses its security rules.
    if (emulatorHost) return "Bearer owner";
    if (!token || now() >= token.expiresAt) {
      const res = await fetchImpl(metadataTokenUrl, { headers: { "Metadata-Flavor": "Google" } });
      if (!res.ok) throw new Error(`Metadata server token request failed: ${res.status}`);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      // Refreshed a minute early, so a token never expires mid-request.
      token = { value: body.access_token, expiresAt: now() + (body.expires_in - 60) * 1000 };
    }
    return `Bearer ${token.value}`;
  }

  async function call(url: string, init: RequestInit = {}) {
    return fetchImpl(url, {
      ...init,
      headers: { Authorization: await authorization(), "Content-Type": "application/json" },
    });
  }

  async function failure(res: Response, what: string): Promise<Error> {
    const text = await res.text();
    return new Error(`Firestore ${what} failed: ${res.status} ${text}`.trim());
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
      const url = `${documentsUrl}/${path.split("/").map(encodeURIComponent).join("/")}`;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await call(url);
        if (!res.ok && res.status !== 404) throw await failure(res, `read of ${path}`);
        const current =
          res.status === 404
            ? undefined
            : ((await res.json()) as { fields?: FirestoreFields; updateTime: string });

        const { doc, result } = change(current && decodeFields(current.fields ?? {}));
        if (!doc) return result;

        const commit = await call(`${documentsUrl}:commit`, {
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
        if (!status || !conflictStatuses.has(status)) throw await failure(commit, `commit of ${path}`);
      }
      throw new Error(`Firestore update of ${path} gave up after ${maxAttempts} conflicts`);
    },
  };
}
