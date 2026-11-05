import { expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { contactQuestion, profile } from "../src/content/profile";

// "ask my agent" on a phone (#49). Runs on the iPhone (WebKit) profile in CI,
// and at the same size on Chromium. The agent is stubbed with route
// interception, as in contact.spec.ts; each reply waits until the test lets it
// go, so the page can be measured before and after the answer lands.
const EMAIL = "ada@example.test";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Stub `url`; the reply is held until `release()` is called. */
async function heldStub(page: Page, url: string, reply: (route: Route) => Promise<void>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(url, async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: cors });
    }
    await released;
    await reply(route);
  });
  return release;
}

const sse = (...events: object[]) =>
  events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

const answer = (route: Route) =>
  route.fulfill({
    status: 200,
    headers: { ...cors, "Content-Type": "text/event-stream" },
    body: sse(
      { type: "tool_call", id: "t1", name: "get_contact", input: {} },
      { type: "text", delta: `You can email Alberto at ${EMAIL}.` },
      { type: "done", stopReason: "end_turn", usage: {} },
    ),
  });

const unavailable = (route: Route) =>
  route.fulfill({
    status: 503,
    headers: cors,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "unavailable", message: "Resting.", resetsAt: "2026-12-01T00:00:00.000Z" },
    }),
  });

const mcpContact = (route: Route) =>
  route.fulfill({
    status: 200,
    headers: cors,
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { email: EMAIL } } }),
  });

const conversation = (page: Page) => page.getByRole("log", { name: /conversation/i });
const tap = (target: Locator, hasTouch: boolean) => (hasTouch ? target.tap() : target.click());

/** Where the chat section sits in the viewport, once scrolling has settled. */
async function chatTop(page: Page) {
  const section = page.locator("#agent");
  let last = NaN;
  await expect
    .poll(async () => {
      const { y } = (await section.boundingBox())!;
      const settled = Math.abs(y - last) < 0.5;
      last = y;
      return settled;
    })
    .toBe(true);
  return last;
}

const horizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Tap "ask my agent" and wait for the question to show in the chat. */
async function askMyAgent(page: Page, hasTouch: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#contact");
  await tap(page.locator("#contact").getByRole("button", { name: "ask my agent" }), hasTouch);
  await expect(conversation(page).getByText(contactQuestion, { exact: true })).toBeVisible();
}

/** A link a finger can hit: in view, unobscured, and not cut off at the edge. */
async function expectTappable(page: Page, link: Locator) {
  await expect(link).toBeInViewport({ ratio: 1 });
  // A trial tap runs Playwright's hit-test (nothing on top of it) without
  // following the link.
  await link.tap({ trial: true });
  const box = (await link.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

test.describe("'ask my agent' on a phone", () => {
  // iPhone XS size; the WebKit project sets this (and touch) on its own.
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("a tap scrolls to the chat, sends the question and the answer's mailto: link is tappable", async ({
    page,
    hasTouch,
  }) => {
    const release = await heldStub(page, "**/chat", answer);

    await askMyAgent(page, hasTouch);

    await expect(page.locator("#agent")).toBeInViewport();
    expect(await horizontalOverflow(page)).toBe(0);

    release();
    const link = conversation(page).getByRole("link", { name: EMAIL });
    await expect(link).toHaveAttribute("href", `mailto:${EMAIL}`);
    await expectTappable(page, link);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test("the MCP fallback answer lands without shifting the chat or scrolling sideways", async ({
    page,
    hasTouch,
  }) => {
    const releaseChat = await heldStub(page, "**/chat", unavailable);
    const releaseMcp = await heldStub(page, "**/mcp", mcpContact);

    await askMyAgent(page, hasTouch);
    const before = await chatTop(page);

    releaseChat();
    releaseMcp();
    const log = conversation(page);
    await expect(log.getByText(/here's the answer straight from my tools/i)).toBeVisible();
    const link = log.getByRole("link", { name: EMAIL });
    await expect(link).toHaveAttribute("href", `mailto:${EMAIL}`);

    expect(await chatTop(page)).toBeCloseTo(before, 0);
    expect(await horizontalOverflow(page)).toBe(0);
    await expectTappable(page, link);
  });

  test("the LinkedIn fallback lands without shifting the chat or scrolling sideways", async ({
    page,
    hasTouch,
  }) => {
    const releaseChat = await heldStub(page, "**/chat", (route) => route.abort("connectionrefused"));
    const releaseMcp = await heldStub(page, "**/mcp", (route) => route.abort("connectionrefused"));

    await askMyAgent(page, hasTouch);
    const before = await chatTop(page);

    releaseChat();
    releaseMcp();
    const link = conversation(page).getByRole("link", { name: "LinkedIn" });
    await expect(link).toHaveAttribute("href", profile.links.linkedin);

    expect(await chatTop(page)).toBeCloseTo(before, 0);
    expect(await horizontalOverflow(page)).toBe(0);
    await expectTappable(page, link);
  });
});
