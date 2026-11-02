import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Segment, TypewriterTerminal } from "./typewriter-terminal";

const segments: Segment[] = [
  { text: "❯ " },
  { text: "whoami", typed: true },
  { text: "\n" },
  { text: "I write notes on engines." },
];

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

// Pieces of text the visitor can currently see (not opacity 0).
function visibleText(container: HTMLElement) {
  const pre = container.querySelector("pre")!;
  let text = "";
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest('[style*="opacity: 0"]')) continue;
    text += node.textContent;
  }
  return text;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TypewriterTerminal", () => {
  it("keeps the full text in the DOM from the first render", () => {
    stubReducedMotion(false);
    render(<TypewriterTerminal segments={segments} />);

    expect(screen.getByText("whoami")).toBeInTheDocument();
    expect(screen.getByText("I write notes on engines.")).toBeInTheDocument();
  });

  it("reveals the command character by character, then its output", () => {
    stubReducedMotion(false);
    const { container } = render(<TypewriterTerminal segments={segments} />);

    expect(visibleText(container)).toBe("");

    act(() => vi.advanceTimersByTime(600));
    const partway = visibleText(container);
    expect(partway.startsWith("❯ w")).toBe(true);
    expect(partway).not.toContain("I write");

    act(() => vi.advanceTimersByTime(5000));
    expect(visibleText(container)).toBe("❯ whoami\nI write notes on engines.");
  });

  it("finishes within a couple of seconds", () => {
    stubReducedMotion(false);
    const { container } = render(<TypewriterTerminal segments={segments} />);

    act(() => vi.advanceTimersByTime(2500));
    expect(visibleText(container)).toBe("❯ whoami\nI write notes on engines.");
  });

  it("shows the full text immediately when reduced motion is preferred", () => {
    stubReducedMotion(true);
    const { container } = render(<TypewriterTerminal segments={segments} />);

    expect(visibleText(container)).toBe("❯ whoami\nI write notes on engines.");
  });
});
