import { chatStream, done } from "../src/testing/agent-fakes";
import { ask, conversation, expect, horizontalOverflow, markdownAnswer, test } from "./fixtures";

// The page fits a phone: no horizontal scroll and no clipped code, on load and
// in the states that add width (a long chat answer, expanded experience
// entries, the open section menu). Each overflow check lives here, once; the
// phone "ask my agent" flows measure their own steps (contact-mobile.spec.ts).
// Runs on Chromium and on the iPhone (WebKit) profile.

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

test.describe("at 375px width", () => {
  test.use({ viewport: { width: 375, height: 812 } });

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
