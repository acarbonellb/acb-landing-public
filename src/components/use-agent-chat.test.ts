import { act, renderHook, waitFor } from "@testing-library/react";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { type PostHogClient, attachClient, resetAnalytics } from "@/lib/analytics";
import { chatError, chatStream, controlledChatStream, done, fakeFetch } from "@/testing/agent-fakes";
import { useAgentChat } from "./use-agent-chat";

// Every question sent is reported ended exactly once, with an honest
// outcome, however it ends (docs/analytics.md#events). The browser tests
// cover the events on the wire; the paths they can't reach are here.
const CHAT_URL = "http://agent.test/chat";

let capture: Mock<PostHogClient["capture"]>;
beforeEach(() => {
  resetAnalytics("phc_test");
  capture = vi.fn<PostHogClient["capture"]>();
  attachClient({ init: vi.fn(), capture });
});

/** The events reported so far, as `[name, properties without ms]`. */
const reported = () =>
  capture.mock.calls.map(([event, properties]) => {
    const { ms, ...rest } = (properties ?? {}) as Record<string, unknown>;
    return [event, event === "chat_question_ended" ? { ...rest, ms: typeof ms } : rest];
  });

const sent = { source: "input" };
const ended = (outcome: string) => ["chat_question_ended", { source: "input", outcome, ms: "number" }];

describe("useAgentChat's analytics", () => {
  it("reports an answered question sent and then ended with its stop reason", async () => {
    const { fetch } = fakeFetch(chatStream({ type: "text", delta: "Hi" }, done("max_tokens")));
    const { result } = renderHook(() => useAgentChat({ chatUrl: CHAT_URL, fetch }));

    await act(() => result.current.ask("Hello?"));

    expect(reported()).toEqual([["chat_question_sent", sent], ended("max_tokens")]);
  });

  it("reports the error kind when the chat fails with a notice", async () => {
    const { fetch } = fakeFetch(chatError({ code: "rate_limited", message: "slow down" }));
    const { result } = renderHook(() => useAgentChat({ chatUrl: CHAT_URL, fetch }));

    await act(() => result.current.ask("Hello?"));

    expect(reported()).toEqual([["chat_question_sent", sent], ended("rate_limited")]);
  });

  it("reports `error`, and ends the turn, when the contact fallback throws", async () => {
    const { fetch } = fakeFetch(chatError({ code: "unavailable", message: "down" }));
    const { result } = renderHook(() => useAgentChat({ chatUrl: CHAT_URL, fetch }));
    const fallback = vi.fn(async () => {
      throw new Error("MCP down too");
    });

    await act(() => result.current.ask("Hello?", { fallback }).catch(() => {}));

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(reported()).toEqual([["chat_question_sent", sent], ended("error")]);
    expect(result.current.busy).toBe(false);
  });

  it("reports `error` when the request itself throws", async () => {
    // A response whose body isn't a stream: reading it throws past the
    // client's own error handling.
    const fetch = async () => ({ ok: true, status: 200, body: {} }) as unknown as Response;
    const { result } = renderHook(() => useAgentChat({ chatUrl: CHAT_URL, fetch }));

    await act(() => result.current.ask("Hello?").catch(() => {}));

    expect(reported()).toEqual([["chat_question_sent", sent], ended("error")]);
    expect(result.current.busy).toBe(false);
  });

  it("reports `abandoned` once when the chat unmounts mid-answer", async () => {
    const stream = controlledChatStream();
    const { fetch } = fakeFetch(stream.response);
    const { result, unmount } = renderHook(() => useAgentChat({ chatUrl: CHAT_URL, fetch }));

    let asking!: Promise<void>;
    act(() => {
      asking = result.current.ask("Hello?");
    });
    await waitFor(() => expect(reported()).toEqual([["chat_question_sent", sent]]));
    unmount();
    // The fake fetch ignores the abort: end its stream as a real one would.
    stream.close();
    await asking;

    expect(reported()).toEqual([["chat_question_sent", sent], ended("abandoned")]);
  });

  it("reports `abandoned` once when the visitor leaves mid-answer, and not again as it ends", async () => {
    const stream = controlledChatStream();
    const { fetch } = fakeFetch(stream.response);
    const { result } = renderHook(() => useAgentChat({ chatUrl: CHAT_URL, fetch }));

    let asking!: Promise<void>;
    act(() => {
      asking = result.current.ask("Hello?");
    });
    await waitFor(() => expect(reported()).toHaveLength(1));
    window.dispatchEvent(new Event("pagehide"));
    stream.push(done());
    await act(() => asking);

    expect(reported()).toEqual([["chat_question_sent", sent], ended("abandoned")]);
  });
});
