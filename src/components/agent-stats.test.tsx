import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WeekStats } from "@/shared/stats-contract";
import { AgentStats } from "./agent-stats";

const STATS_URL = "http://agent.test/stats";

function week(name: string, chat: Partial<WeekStats["chat"]> = {}): WeekStats {
  return {
    week: name,
    startsAt: "2026-11-02T00:00:00.000Z",
    chat: {
      requests: 0,
      answered: 0,
      outcomes: {},
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      errorRate: null,
      latency: { p50Ms: null, p95Ms: null },
      firstText: { p50Ms: null, p95Ms: null },
      ...chat,
    },
    mcp: { requests: 0 },
  };
}

function serving(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetch = (async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

const busyWeek = week("2026-W45", {
  requests: 26,
  answered: 24,
  costUsd: 0.0312,
  errorRate: 0.04,
  latency: { p50Ms: 2000, p95Ms: 7500 },
});

describe("AgentStats", () => {
  it("shows this week's questions answered, p50 latency, error rate and cost", async () => {
    const { fetch, urls } = serving({ current: busyWeek, previous: week("2026-W44") });
    render(<AgentStats url={STATS_URL} fetch={fetch} />);

    expect(
      await screen.findByText("this week: 24 questions answered · p50 2 s · 4% errors · $0.03"),
    ).toBeInTheDocument();
    expect(urls).toEqual([STATS_URL]);
  });

  it("shows last week's until this week has an answer, rounding small figures", async () => {
    const quiet = week("2026-W44", {
      requests: 1,
      answered: 1,
      costUsd: 0.0004,
      errorRate: 0,
      latency: { p50Ms: 500, p95Ms: 500 },
    });
    const { fetch } = serving({ current: week("2026-W45", { requests: 1 }), previous: quiet });
    render(<AgentStats url={STATS_URL} fetch={fetch} />);

    expect(
      await screen.findByText("last week: 1 question answered · p50 0.5 s · 0% errors · <$0.01"),
    ).toBeInTheDocument();
  });

  it("leaves out figures it has no value for", async () => {
    const partial = week("2026-W45", { answered: 3, requests: 3, costUsd: 0.12 });
    const { fetch } = serving({ current: partial, previous: week("2026-W44") });
    render(<AgentStats url={STATS_URL} fetch={fetch} />);

    expect(await screen.findByText("this week: 3 questions answered · $0.12")).toBeInTheDocument();
  });

  it.each([
    ["the agent answers an error", serving({ error: { code: "unavailable" } }, 503).fetch],
    ["the answer isn't the stats", serving({ hello: "world" }).fetch],
    ["no question was answered in either week", serving({ current: week("W45"), previous: week("W44") }).fetch],
    [
      "the agent can't be reached",
      (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof globalThis.fetch,
    ],
  ])("shows nothing when %s", async (_, fetch) => {
    let called = false;
    const watched = (async (...args: Parameters<typeof globalThis.fetch>) => {
      called = true;
      return fetch(...args);
    }) as typeof globalThis.fetch;
    const { container } = render(<AgentStats url={STATS_URL} fetch={watched} />);

    await waitFor(() => expect(called).toBe(true));
    // Give the response a turn to land, then check nothing rendered.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container).toBeEmptyDOMElement();
  });
});
