import type { Locator, Page } from "@playwright/test";
import { chatError, contactAnswer, mcpContact } from "../src/testing/agent-fakes";
import { contactQuestion } from "../src/shared/site-copy";
import { conversation, expect, horizontalOverflow, test } from "./fixtures";

// "ask my agent" on a phone (#49). Runs on the iPhone (WebKit) profile in CI,
// and at the same size on Chromium. Of the contact fallback matrix (unit-tested
// in src/components/contact-ask.test.tsx), each browser runs the happy path
// and one fallback: the spend cap's 503, answered by the MCP get_contact tool.
// Each stubbed reply is held until the test lets it go, so the page can be
// measured before and after the answer lands.
const EMAIL = "ada@example.test";

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

  test("the chat input's text is at least 16px, so iOS Safari doesn't zoom in on focus", async ({
    page,
  }) => {
    await page.goto("/#agent");
    const input = page.getByRole("textbox", { name: /ask the agent/i });
    const fontSize = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });

  test("a tap scrolls to the chat, sends the question and the answer's mailto: link is tappable", async ({
    page,
    hasTouch,
    agent,
  }) => {
    const chat = await agent.chat(contactAnswer(EMAIL), { hold: true });

    await askMyAgent(page, hasTouch);

    await expect(page.locator("#agent")).toBeInViewport();
    expect(await horizontalOverflow(page)).toBe(0);

    chat.release();
    const link = conversation(page).getByRole("link", { name: EMAIL });
    await expect(link).toHaveAttribute("href", `mailto:${EMAIL}`);
    await expectTappable(page, link);
    expect(await horizontalOverflow(page)).toBe(0);
    expect(chat.requests).toEqual([{ messages: [{ role: "user", content: contactQuestion }] }]);
  });

  test("the MCP fallback answer lands without shifting the chat or scrolling sideways", async ({
    page,
    hasTouch,
    agent,
  }) => {
    const chat = await agent.chat(
      chatError({ code: "unavailable", message: "Resting.", resetsAt: "2026-12-01T00:00:00.000Z" }),
      { hold: true },
    );
    const mcp = await agent.mcp(mcpContact(EMAIL), { hold: true });

    await askMyAgent(page, hasTouch);
    const before = await chatTop(page);

    chat.release();
    mcp.release();
    const log = conversation(page);
    await expect(
      log.getByText(/the model is unavailable; here's the answer straight from my tools/i),
    ).toBeVisible();
    const link = log.getByRole("link", { name: EMAIL });
    await expect(link).toHaveAttribute("href", `mailto:${EMAIL}`);

    expect(await chatTop(page)).toBeCloseTo(before, 0);
    expect(await horizontalOverflow(page)).toBe(0);
    await expectTappable(page, link);
    expect(mcp.requests).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_contact", arguments: {} },
      },
    ]);
  });
});
