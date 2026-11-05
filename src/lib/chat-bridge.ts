// How the contact section's "ask my agent" button reaches the chat in the
// agent section (#50): the two are separate client components, so the chat
// connects here while mounted and the button reads its state. Without the
// chat (no JavaScript, or a build with no agent) the state stays "absent" and
// the button falls back to a link.
import { useSyncExternalStore } from "react";

export type ChatBridgeState = "absent" | "ready" | "busy";

let ask: (() => void) | null = null;
let state: ChatBridgeState = "absent";
const listeners = new Set<() => void>();

function setState(next: ChatBridgeState) {
  if (next === state) return;
  state = next;
  listeners.forEach((listener) => listener());
}

/** Called by the chat on mount: how to ask it the contact question. */
export function connectChat(askForContact: () => void) {
  ask = askForContact;
  setState("ready");
  return {
    /** While an answer streams, the button is disabled. */
    setBusy: (busy: boolean) => {
      if (ask === askForContact) setState(busy ? "busy" : "ready");
    },
    disconnect: () => {
      if (ask !== askForContact) return;
      ask = null;
      setState("absent");
    },
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The chat's state for the button, and the ask itself (only when "ready"). */
export function useChatBridge(): { state: ChatBridgeState; askForContact: () => void } {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => "absent" as const,
  );
  return {
    state: current,
    askForContact: () => {
      if (state === "ready") ask?.();
    },
  };
}
