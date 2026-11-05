import type { Page } from "@playwright/test";
import { json, stats, weekStats } from "../src/testing/agent-fakes";
import { expect, test } from "./fixtures";

// The usage line reads the agent's public GET /stats from the browser; the
// `agent` fixture stubs it.

const week = (name: string, answered: number) => ({
  ...weekStats(name, {
    requests: answered + 1,
    answered,
    outcomes: { end_turn: answered, "error:internal": 1 },
    inputTokens: 120_000,
    outputTokens: 9_000,
    costUsd: 0.0165,
    errorRate: 1 / (answered + 1),
    latency: { p50Ms: 3000, p95Ms: 7500 },
    firstText: { p50Ms: 1000, p95Ms: 2000 },
  }),
  mcp: { requests: 4 },
});

function agentSection(page: Page) {
  return page.getByRole("region", { name: /ask my agent/ });
}

test("shows the agent's usage this week next to the chat", async ({ page, agent }) => {
  await agent.stats(stats({ current: week("2026-W45", 19), previous: week("2026-W44", 0) }));
  await page.goto("/");

  await expect(
    agentSection(page).getByText(
      "this week: 19 questions answered · p50 3 s · 5% errors · $0.02",
    ),
  ).toBeVisible();
});

test("hides the line when the stats are unavailable", async ({ page, agent }) => {
  await agent.stats(json(503, { error: { code: "unavailable", message: "Usage stats are unavailable." } }));
  const answered = page.waitForResponse("**/stats");
  await page.goto("/");
  await answered;

  await expect(agentSection(page).getByRole("textbox", { name: /ask the agent/i })).toBeVisible();
  await expect(agentSection(page).getByText(/questions? answered/)).toHaveCount(0);
});
