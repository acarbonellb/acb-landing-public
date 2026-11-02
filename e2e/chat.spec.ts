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

  const alert = page.locator("#agent").getByRole("alert");
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
    }),
  );
  await page.goto("/#agent");

  await ask(page, "Hi");

  const alert = page.locator("#agent").getByRole("alert");
  await expect(alert).toContainText("The agent is unavailable right now.");
  await expect(alert).toContainText("The chat is resting until next month.");
  await expectAccessible(page);
});

test("shows an error when the agent can't be reached", async ({ page }) => {
  await page.route(CHAT, (route) => route.abort("connectionrefused"));
  await page.goto("/#agent");

  await ask(page, "Hi");

  await expect(page.locator("#agent").getByRole("alert")).toContainText("Something went wrong.");
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
