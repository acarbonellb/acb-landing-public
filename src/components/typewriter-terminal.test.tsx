import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Segment, TypewriterTerminal } from "./typewriter-terminal";

const segments: Segment[] = [
  { text: "❯ " },
  { text: "whoami", typed: true },
  { text: "\n" },
  { text: "I write notes on engines." },
];

const fullText = "❯ whoami\nI write notes on engines.";

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion: reduce"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

// The on-screen terminal, as a sighted visitor reads it.
const shown = (text: string) => screen.getByText(text, { exact: true });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TypewriterTerminal", () => {
  it("gives screen readers the full text from the first render", () => {
    stubReducedMotion(false);
    render(<TypewriterTerminal segments={segments} />);

    expect(
      screen.getByText(fullText, { normalizer: (s) => s }),
    ).toBeInTheDocument();
  });

  it("reveals the command character by character, then its output", () => {
    stubReducedMotion(false);
    render(<TypewriterTerminal segments={segments} />);

    expect(shown("whoami")).not.toBeVisible();
    expect(shown("I write notes on engines.")).not.toBeVisible();

    act(() => vi.advanceTimersByTime(400));
    expect(shown("wh")).toBeVisible();
    expect(shown("oami")).not.toBeVisible();

    act(() => vi.advanceTimersByTime(250));
    expect(shown("whoami")).toBeVisible();
    expect(shown("I write notes on engines.")).not.toBeVisible();

    act(() => vi.advanceTimersByTime(5000));
    expect(shown("I write notes on engines.")).toBeVisible();
  });

  it("finishes within a couple of seconds", () => {
    stubReducedMotion(false);
    render(<TypewriterTerminal segments={segments} />);

    act(() => vi.advanceTimersByTime(2500));
    expect(shown("whoami")).toBeVisible();
    expect(shown("I write notes on engines.")).toBeVisible();
  });

  it("shows the full text immediately when reduced motion is preferred", () => {
    stubReducedMotion(true);
    render(<TypewriterTerminal segments={segments} />);

    expect(shown("whoami")).toBeVisible();
    expect(shown("I write notes on engines.")).toBeVisible();
  });
});
