// Watches for the model provider's own spend or credit limit (a workspace or
// organization spend limit, or no credit left: `anthropic.ts`). Hitting it
// means the code's spend cap (`spend-cap.ts`) and the provider's limit have
// drifted apart, so the owner is told with a `provider_limit` alert event
// (README, "Logs and alert events").
//
// Once per crossing: the month's spend document notes the limit under
// `alerted.provider_limit` when it's first hit, and clears it when a model
// call next succeeds (logging `provider_limit_cleared`), so it holds across
// instances and cold starts. Each instance also remembers the last state it
// saw, so a model call that succeeds normally costs no store operation.
import type { DocumentStore } from "./document-store";
import { logEvent, logStoreError } from "./log";
import { ModelUnavailableError, type ModelClient } from "./model";
import { spendPath } from "./spend-cap";

export interface ProviderLimitWatch {
  /** A model call was refused by the provider's limit. Never throws. */
  reached(): Promise<void>;
  /** A model call succeeded. Never throws. */
  answered(): Promise<void>;
}

export type ProviderLimitWatchOptions = {
  /** The store of the monthly spend documents. */
  store: DocumentStore;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
};

const flag = "provider_limit";

export function createProviderLimitWatch({
  store,
  now = Date.now,
}: ProviderLimitWatchOptions): ProviderLimitWatch {
  // The limit's state as last seen here; unknown after a cold start.
  let lastSeen: boolean | undefined;

  /** Sets the month's flag to `limited`; `changed` if it wasn't already. */
  async function setLimitFlag(limited: boolean): Promise<{ changed: boolean; month: string } | undefined> {
    const path = spendPath(now());
    try {
      const changed = await store.update(path, (doc) => {
        // The rest of the month's document is the spend cap's, kept as it is.
        const alerted = { ...(doc?.alerted as Record<string, boolean> | undefined) };
        if (Boolean(alerted[flag]) === limited) return { result: false };
        return { doc: { ...doc, alerted: { ...alerted, [flag]: limited } }, result: true };
      });
      lastSeen = limited;
      return { changed, month: path.split("/")[1] };
    } catch (error) {
      logStoreError("provider_limit", "Provider limit: could not note its state", error);
      return undefined;
    }
  }

  return {
    async reached() {
      if (lastSeen === true) return;
      const set = await setLimitFlag(true);
      if (set?.changed) {
        logEvent("ERROR", "provider_limit", "The model provider's spend or credit limit refused a call", {
          month: set.month,
        });
      }
    },
    async answered() {
      if (lastSeen === false) return;
      const set = await setLimitFlag(false);
      if (set?.changed) {
        logEvent("INFO", "provider_limit_cleared", "The model provider answers again", {
          month: set.month,
        });
      }
    },
  };
}

/** `model`, reporting each call's provider-limit refusal or success to `watch`. */
export function watchingProviderLimit(model: ModelClient, watch: ProviderLimitWatch): ModelClient {
  return {
    async *stream(request) {
      try {
        for await (const event of model.stream(request)) {
          if (event.type === "response_end") await watch.answered();
          yield event;
        }
      } catch (error) {
        if (error instanceof ModelUnavailableError && error.reason === "provider_limit") {
          await watch.reached();
        }
        throw error;
      }
    },
  };
}
