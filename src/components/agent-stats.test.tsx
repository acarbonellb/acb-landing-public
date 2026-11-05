import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeFetch, json, stats, weekStats } from "@/testing/agent-fakes";
import { AgentStats } from "./agent-stats";

const STATS_URL = "http://agent.test/stats";

const week = weekStats;

const busyWeek = week("2026-W45", {
  requests: 26,
  answered: 24,
  costUsd: 0.0312,
  errorRate: 0.04,
  latency: { p50Ms: 2000, p95Ms: 7500 },
});

describe("AgentStats", () => {
  it("shows this week's questions answered, p50 latency, error rate and cost", async () => {
    const { fetch, requests } = fakeFetch(stats({ current: busyWeek, previous: week("2026-W44") }));
    render(<AgentStats url={STATS_URL} fetch={fetch} />);

    expect(
      await screen.findByText("this week: 24 questions answered · p50 2 s · 4% errors · $0.03"),
    ).toBeInTheDocument();
    expect(requests.map((r) => r.url)).toEqual([STATS_URL]);
  });

  it("shows last week's until this week has an answer, rounding small figures", async () => {
    const quiet = week("2026-W44", {
      requests: 1,
      answered: 1,
      costUsd: 0.0004,
      errorRate: 0,
      latency: { p50Ms: 500, p95Ms: 500 },
    });
    const { fetch } = fakeFetch(stats({ current: week("2026-W45", { requests: 1 }), previous: quiet }));
    render(<AgentStats url={STATS_URL} fetch={fetch} />);

    expect(
      await screen.findByText("last week: 1 question answered · p50 0.5 s · 0% errors · <$0.01"),
    ).toBeInTheDocument();
  });

  it("leaves out figures it has no value for", async () => {
    const partial = week("2026-W45", { answered: 3, requests: 3, costUsd: 0.12 });
    const { fetch } = fakeFetch(stats({ current: partial, previous: week("2026-W44") }));
    render(<AgentStats url={STATS_URL} fetch={fetch} />);

    expect(await screen.findByText("this week: 3 questions answered · $0.12")).toBeInTheDocument();
  });

  it.each([
    ["the agent answers an error", fakeFetch(json(503, { error: { code: "unavailable" } })).fetch],
    ["the answer isn't the stats", fakeFetch(json(200, { hello: "world" })).fetch],
    [
      "no question was answered in either week",
      fakeFetch(stats({ current: week("W45"), previous: week("W44") })).fetch,
    ],
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

  // Every field the line reads must be checked, not only the ones that exist
  // today: a malformed week hides the line rather than showing "NaN".
  it.each([
    ["the error rate", (w: WeekStats) => ({ ...w, chat: { ...w.chat, errorRate: undefined } })],
    ["a numeric error rate", (w: WeekStats) => ({ ...w, chat: { ...w.chat, errorRate: "4%" } })],
    ["the latency", (w: WeekStats) => ({ ...w, chat: { ...w.chat, latency: undefined } })],
    [
      "the p50 latency",
      (w: WeekStats) => ({ ...w, chat: { ...w.chat, latency: { p95Ms: 7500 } } }),
    ],
    ["the questions answered", (w: WeekStats) => ({ ...w, chat: { ...w.chat, answered: "24" } })],
    ["the cost", (w: WeekStats) => ({ ...w, chat: { ...w.chat, costUsd: undefined } })],
  ])("shows nothing when a week lacks %s", async (_, malform) => {
    const { fetch, urls } = serving({ current: malform(busyWeek), previous: week("2026-W44") });
    const { container } = render(<AgentStats url={STATS_URL} fetch={fetch} />);

    await waitFor(() => expect(urls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container).toBeEmptyDOMElement();
  });
});
