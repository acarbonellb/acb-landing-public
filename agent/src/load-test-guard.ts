// The load test's one safety check (`agent/scripts/load-test.ts`): it floods
// the store with writes, so it only ever runs against the Firestore emulator
// on this machine, never against a real database or a deployed revision.
import type { Config } from "./config";

export type EmulatorStore = { projectId: string; databaseId: string; emulatorHost: string };

/** Hosts that are this machine. */
const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The host of `host:port` (an IPv6 host in brackets keeps them). */
const hostOf = (hostPort: string) => (hostPort.startsWith("[") ? hostPort.slice(0, hostPort.indexOf("]") + 1) : hostPort.split(":")[0]);

/**
 * `store` if it is the Firestore emulator on this machine; otherwise throws,
 * saying what to set.
 */
export function emulatorStoreOrRefuse(store: Config["store"]): EmulatorStore {
  const refuse = (why: string): never => {
    throw new Error(
      `Refusing to run the load test: ${why}. It only runs against the Firestore emulator on this machine: ` +
        "set AGENT_STORE=firestore, FIRESTORE_PROJECT_ID and FIRESTORE_EMULATOR_HOST=localhost:<port> (docs/development.md)",
    );
  };
  if (store.kind !== "firestore") return refuse("the store is in memory, not the emulator");
  const { projectId, databaseId, emulatorHost } = store;
  if (!emulatorHost) return refuse("FIRESTORE_EMULATOR_HOST is unset, so the store is the real Firestore");
  if (!loopback.has(hostOf(emulatorHost))) {
    return refuse(`FIRESTORE_EMULATOR_HOST is not on this machine (${emulatorHost})`);
  }
  return { projectId, databaseId, emulatorHost };
}
