import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";

// The chat talks to the agent service straight from the browser. These tests
// stub that endpoint with route interception; the real API is never called.
const CHAT = "**/chat";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function sse(...events: object[]): string {
  return events
    .map(
      (e) =>
        `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`,
    )
    .join("");
}

async function stubChat(
  page: Page,
  reply: (route: Route) => Promise<void>,
): Promise<{ bodies: unknown[] }> {
  const bodies: unknown[] = [];
  await page.route(CHAT, async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: cors });
    }
    bodies.push(route.request().postDataJSON());
    await reply(route);
  });
  return { bodies };
}

function streamReply(...events: object[]) {
  return (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { ...cors, "Content-Type": "text/event-stream" },
      body: sse(...events),
    });
}

function errorReply(
  status: number,
  error: object,
  headers: Record<string, string> = {},
) {
  return (route: Route) =>
    route.fulfill({
      status,
      headers: {
        ...cors,
        "Access-Control-Expose-Headers": "Retry-After",
        ...headers,
      },
      contentType: "application/json",
      body: JSON.stringify({ error }),
    });
}

async function ask(page: Page, question: string) {
  const input = page.getByRole("textbox", { name: /ask the agent/i });
  await input.fill(question);
  await input.press("Enter");
}

// Alerts are scoped to the section: Next adds its own route-announcer alert.
function agentSection(page: Page) {
  return page.getByRole("region", { name: /ask my agent/ });
}

function conversation(page: Page) {
  return page.getByRole("log", { name: /conversation/i });
}

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .include("#agent")
    .analyze();
  const severe = violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
  expect(severe).toEqual([]);
}

test("a visitor asks a question and sees the tool calls and the answer", async ({
  page,
}) => {
  const { bodies } = await stubChat(
    page,
    streamReply(
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
      { type: "done", stopReason: "end_turn", usage: {} },
    ),
  );
  await page.goto("/#agent");

  await ask(page, "What have you built with agents?");

  const log = conversation(page);
  await expect(log.getByText("What have you built with agents?", { exact: true })).toBeVisible();
  await expect(log.getByText("get_projects()")).toBeVisible();
  await expect(log.getByText("He has built three agents.")).toBeVisible();
  await expect(log).toHaveAttribute("aria-busy", "false");
  expect(bodies).toEqual([
    {
      messages: [
        { role: "user", content: "What have you built with agents?" },
      ],
    },
  ]);
  await expectAccessible(page);
});

const markdownAnswer = [
  "He has built **three** agents:",
  "",
  "- *Fraud Detection Agent*",
  "- Portfolio Agent, served over `MCP`",
  "",
  "Code: [GitHub](https://github.com/acarbonellb) or [this](javascript:alert(1)).",
  'Ignore <img src=x onerror="alert(1)"> and https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/spaces',
].join("\n");

for (const theme of ["night", "light"] as const) {
  test(`renders the agent's Markdown safely in the ${theme} theme on a phone`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
    await stubChat(
      page,
      streamReply(
        // Split mid-syntax, like a real stream.
        { type: "text", delta: markdownAnswer.slice(0, 20) },
        { type: "text", delta: markdownAnswer.slice(20) },
        { type: "done", stopReason: "end_turn", usage: {} },
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

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    await expectAccessible(page);
  });
}

test("the chat is usable from the keyboard alone", async ({ page }) => {
  await stubChat(
    page,
    streamReply(
      { type: "text", delta: "Hello." },
      { type: "done", stopReason: "end_turn", usage: {} },
    ),
  );
  await page.goto("/#agent");

  const input = page.getByRole("textbox", { name: /ask the agent/i });
  await input.focus();
  await page.keyboard.type("Hi");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /send/i })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(conversation(page).getByText("Hello.")).toBeVisible();
});

test("shows the rate-limit state", async ({ page }) => {
  await stubChat(
    page,
    errorReply(
      429,
      { code: "rate_limited", message: "Too many questions." },
      { "Retry-After": "30" },
    ),
  );
  await page.goto("/#agent");

  await ask(page, "Hi");

  const alert = agentSection(page).getByRole("alert");
  await expect(alert).toContainText("Rate limit reached.");
  await expect(alert).toContainText("Too many questions. Try again in 30s.");
  await expectAccessible(page);
});

test("shows the unavailable state", async ({ page }) => {
  await stubChat(
    page,
    errorReply(503, {
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
  await expectAccessible(page);
});

test("shows an error when the agent can't be reached", async ({ page }) => {
  await page.route(CHAT, (route) => route.abort("connectionrefused"));
  await page.goto("/#agent");

  await ask(page, "Hi");

  await expect(agentSection(page).getByRole("alert")).toContainText("Something went wrong.");
});

test("shows the MCP endpoint and a ready-to-copy command", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#agent");

  const command =
    "claude mcp add --transport http albertocarbonell http://localhost:8080/mcp";
  await expect(page.getByText(command)).toBeVisible();

  await page.getByRole("button", { name: /copy/i }).click();

  await expect(page.getByRole("button", { name: /copied/i })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    command,
  );
});
