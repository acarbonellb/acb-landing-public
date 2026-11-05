import type { Page } from "@playwright/test";
import { chatError, chatStream, done } from "../src/testing/agent-fakes";
import { ask, conversation, expect, markdownAnswer, test } from "./fixtures";

// The chat talks to the agent service straight from the browser; the `agent`
// fixture stubs it. Accessibility (a11y.spec.ts) and overflow (layout.spec.ts)
// of these states are checked once, in their own specs.

// Alerts are scoped to the section: Next adds its own route-announcer alert.
function agentSection(page: Page) {
  return page.getByRole("region", { name: /ask my agent/ });
}

test("a visitor asks a question and sees the tool calls and the answer", async ({
  page,
  agent,
}) => {
  const chat = await agent.chat(
    chatStream(
      { type: "tool_call", id: "t1", name: "get_projects", input: {} },
      {
        type: "tool_result",
        id: "t1",
        name: "get_projects",
        isError: false,
        output: [],
      },
      { type: "text", delta: "He has built " },
      { type: "text", delta: "three agents." },
      done(),
    ),
  );
  await page.goto("/#agent");

  await ask(page, "What have you built with agents?");

  const log = conversation(page);
  await expect(log.getByText("What have you built with agents?", { exact: true })).toBeVisible();
  await expect(log.getByText("get_projects()")).toBeVisible();
  await expect(log.getByText("He has built three agents.")).toBeVisible();
  await expect(log).toHaveAttribute("aria-busy", "false");
  expect(chat.requests).toEqual([
    {
      messages: [
        { role: "user", content: "What have you built with agents?" },
      ],
    },
  ]);
});

test("renders the agent's Markdown safely on a phone", async ({ page, agent }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await agent.chat(
    chatStream(
      // Split mid-syntax, like a real stream.
      { type: "text", delta: markdownAnswer.slice(0, 20) },
      { type: "text", delta: markdownAnswer.slice(20) },
      done(),
    ),
  );
  await page.goto("/#agent");

  await ask(page, "What has he **built**?");

  const log = conversation(page);
  await expect(log.getByRole("strong").filter({ hasText: "three" })).toBeVisible();
  await expect(
    log.getByRole("emphasis").filter({ hasText: "Fraud Detection Agent" }),
  ).toBeVisible();
  await expect(log.getByRole("listitem")).toHaveCount(2);
  await expect(log.getByText("What has he **built**?")).toBeVisible();
  const github = log.getByRole("link", { name: "GitHub" });
  await expect(github).toHaveAttribute("href", "https://github.com/acarbonellb");
  await expect(github).toHaveAttribute("target", "_blank");
  await expect(github).toHaveAttribute("rel", "noopener noreferrer");
  await expect(log.getByRole("link")).toHaveCount(1);
  await expect(log.getByRole("img")).toHaveCount(0);
  await expect(log.getByText('<img src=x onerror="alert(1)">')).toBeVisible();
});

test("the chat is usable from the keyboard alone", async ({ page, agent }) => {
  await agent.chat(chatStream({ type: "text", delta: "Hello." }, done()));
  await page.goto("/#agent");

  const input = page.getByRole("textbox", { name: /ask the agent/i });
  await input.focus();
  await page.keyboard.type("Hi");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /send/i })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(conversation(page).getByText("Hello.")).toBeVisible();
});

test("shows the rate-limit state", async ({ page, agent }) => {
  await agent.chat(
    chatError(
      { code: "rate_limited", message: "Too many questions." },
      { headers: { "Retry-After": "30" } },
    ),
  );
  await page.goto("/#agent");

  await ask(page, "Hi");

  const alert = agentSection(page).getByRole("alert");
  await expect(alert).toContainText("Rate limit reached.");
  await expect(alert).toContainText("Too many questions. Try again in 30s.");
});

test("shows the daily quota like a rate limit, with when it resets", async ({ page, agent }) => {
  await agent.chat(
    chatError(
      {
        code: "rate_limited",
        message: "You've asked a lot today.",
        retryAfterSeconds: 7200,
        resetsAt: "2026-11-16T00:00:00.000Z",
      },
      { headers: { "Retry-After": "7200" } },
    ),
  );
  await page.goto("/#agent");

  await ask(page, "Hi");

  const alert = agentSection(page).getByRole("alert");
  await expect(alert).toContainText("Rate limit reached.");
  await expect(alert).toContainText(
    "You've asked a lot today. Try again from 00:00 UTC on November 16, 2026.",
  );
});

test("shows the unavailable state", async ({ page, agent }) => {
  await agent.chat(
    chatError({
      code: "unavailable",
      message: "The chat is resting until next month.",
      resetsAt: "2026-12-01T00:00:00.000Z",
    }),
  );
  await page.goto("/#agent");

  await ask(page, "Hi");

  const alert = agentSection(page).getByRole("alert");
  await expect(alert).toContainText("The agent is unavailable right now.");
  await expect(alert).toContainText("The chat is resting until next month.");
  await expect(alert).toContainText("It's back on December 1, 2026 (UTC).");
});

test("shows an error when the agent can't be reached", async ({ page, agent }) => {
  await agent.chat("unreachable");
  await page.goto("/#agent");

  await ask(page, "Hi");

  await expect(agentSection(page).getByRole("alert")).toContainText("Something went wrong.");
});

test("shows the MCP endpoint on the site's domain and a ready-to-copy command", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#agent");

  // The chat calls the agent's own URL; MCP goes through the /mcp rewrite.
  const command =
    "claude mcp add --transport http albertocarbonell https://albertocarbonell.dev/mcp";
  await expect(page.getByText(command)).toBeVisible();

  await page.getByRole("button", { name: /copy/i }).click();

  await expect(page.getByRole("button", { name: /copied/i })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    command,
  );
});
