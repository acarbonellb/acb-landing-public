import type { Page } from "@playwright/test";
import {
  chatError,
  chatStream,
  contactAnswer,
  done,
  mcpContact,
} from "../src/testing/agent-fakes";
import { contactQuestion } from "../src/shared/site-copy";
import { ask, conversation, expect, horizontalOverflow, markdownAnswer, test } from "./fixtures";

// The page fits a phone: no horizontal scroll and no clipped code, on load and
// in the states that add width (a long chat answer, expanded experience
// entries, the open section menu, the "ask my agent" answers). Each overflow
// check lives here, once; contact-mobile.spec.ts covers the rest of the phone
// "ask my agent" flow. Runs on Chromium and on the iPhone (WebKit) profile.

for (const width of [360, 375, 390]) {
  test.describe(`at ${width}px width`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("has no horizontal scroll", async ({ page }) => {
      await page.goto("/");

      expect(await horizontalOverflow(page)).toBe(0);
    });

    test("code blocks fit without clipping or inner scroll", async ({ page }) => {
      await page.goto("/");

      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll("pre, code")]
          .filter((el) => el.scrollWidth > el.clientWidth)
          .map((el) => el.textContent?.slice(0, 40)),
      );
      expect(clipped).toEqual([]);
    });
  });
}

test.describe("at 360px width", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("a long Markdown answer in the chat wraps instead of scrolling sideways", async ({
    page,
    agent,
  }) => {
    await agent.chat(chatStream({ type: "text", delta: markdownAnswer }, done()));
    await page.goto("/#agent");

    await ask(page, "What has he **built**?");
    await expect(conversation(page).getByRole("link", { name: "GitHub" })).toBeVisible();

    expect(await horizontalOverflow(page)).toBe(0);
  });

  test("every experience entry expanded still fits", async ({ page }) => {
    await page.goto("/");

    for (const button of await page.getByRole("button", { name: /^git show / }).all()) {
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
    }

    expect(await horizontalOverflow(page)).toBe(0);
  });
});

/** Press "ask my agent" and wait for the question to show in the chat. */
async function askMyAgent(page: Page) {
  await page.goto("/#contact");
  await page.locator("#contact").getByRole("button", { name: "ask my agent" }).click();
  await expect(conversation(page).getByText(contactQuestion, { exact: true })).toBeVisible();
}

const EMAIL = "ada@example.test";

test.describe("at 375px width", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("'ask my agent' fits while the answer streams and once it lands", async ({
    page,
    agent,
  }) => {
    const chat = await agent.chat(contactAnswer(EMAIL), { hold: true });

    await askMyAgent(page);
    expect(await horizontalOverflow(page)).toBe(0);

    chat.release();
    await expect(conversation(page).getByRole("link", { name: EMAIL })).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test("the contact fallback's MCP answer fits", async ({ page, agent }) => {
    await agent.chat(
      chatError({ code: "unavailable", message: "Resting.", resetsAt: "2026-12-01T00:00:00.000Z" }),
    );
    await agent.mcp(mcpContact(EMAIL));

    await askMyAgent(page);
    await expect(conversation(page).getByRole("link", { name: EMAIL })).toBeVisible();

    expect(await horizontalOverflow(page)).toBe(0);
  });

  test("the open section menu fits the header", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Section menu" }).click();
    await expect(page.getByRole("button", { name: "Section menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    expect(await horizontalOverflow(page)).toBe(0);
  });
});
