// The load test (`agent/scripts/load-test.ts`) floods the store with writes,
// so it must never reach a real Firestore: it refuses to start unless the
// configured store is the Firestore emulator on this machine.
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { emulatorStoreOrRefuse } from "./load-test-guard";

const storeOf = (env: Record<string, string>) => loadConfig(env).store;

describe("the load test's store guard", () => {
  it("refuses the memory store", () => {
    expect(() => emulatorStoreOrRefuse(storeOf({}))).toThrow(/emulator/);
  });

  it("refuses Firestore without an emulator host: that is the real database", () => {
    expect(() =>
      emulatorStoreOrRefuse(storeOf({ AGENT_STORE: "firestore", FIRESTORE_PROJECT_ID: "acb-landing" })),
    ).toThrow(/FIRESTORE_EMULATOR_HOST/);
  });

  it.each(["firestore.googleapis.com:443", "emulator.example.com:8080", "localhost.example.com:8080"])(
    "refuses an emulator host that isn't on this machine (%s)",
    (host) => {
      expect(() =>
        emulatorStoreOrRefuse(
          storeOf({ AGENT_STORE: "firestore", FIRESTORE_PROJECT_ID: "demo", FIRESTORE_EMULATOR_HOST: host }),
        ),
      ).toThrow(/this machine/);
    },
  );

  it.each(["localhost:8091", "127.0.0.1:8091", "[::1]:8091"])("accepts the emulator on %s", (host) => {
    expect(
      emulatorStoreOrRefuse(
        storeOf({ AGENT_STORE: "firestore", FIRESTORE_PROJECT_ID: "demo", FIRESTORE_EMULATOR_HOST: host }),
      ),
    ).toEqual({ projectId: "demo", databaseId: "(default)", emulatorHost: host });
  });
});
