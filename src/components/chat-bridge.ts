// How the contact section's "ask my agent" button reaches the chat in the
// agent section: the two are separate client components, so the chat
// connects here while mounted and the button reads its state. The button
// sends its own question and fallback strategy; the chat only asks them.
// Without the chat (no JavaScript, or a build with no agent) the state stays
// "absent" and the button falls back to a link.
import { useSyncExternalStore } from "react";
import type { FallbackStrategy } from "@/lib/contact-fallback";

export type ChatBridgeState = "absent" | "ready" | "busy";

/** Asks the chat `question`; a failure is answered by `fallback`. */
export type BridgeAsk = (question: string, options: { fallback: FallbackStrategy }) => void;

let ask: BridgeAsk | null = null;
let state: ChatBridgeState = "absent";
const listeners = new Set<() => void>();

function setState(next: ChatBridgeState) {
  if (next === state) return;
  state = next;
  listeners.forEach((listener) => listener());
}

/** Called by the chat on mount: how to ask it a question from outside. */
export function connectChat(askChat: BridgeAsk) {
  ask = askChat;
  setState("ready");
  return {
    /** While an answer streams, the button is disabled. */
    setBusy: (busy: boolean) => {
      if (ask === askChat) setState(busy ? "busy" : "ready");
    },
    disconnect: () => {
      if (ask !== askChat) return;
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
export function useChatBridge(): { state: ChatBridgeState; ask: BridgeAsk } {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => "absent" as const,
  );
  return {
    state: current,
    ask: (question, options) => {
      if (state === "ready") ask?.(question, options);
    },
  };
}
