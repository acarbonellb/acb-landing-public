import { expect, type Page, test } from "@playwright/test";
import { profile } from "../src/content/profile";

const finalText = `❯ whoami\n${profile.tagline}\n\n❯ cat status.json\n{ "open_to_work": true, "focus": "AI agents" }`;

const terminal = (page: Page) =>
  page.locator("pre").filter({ hasText: "whoami" });

// Text the visitor can currently see: characters still pending are opacity 0.
function visibleText(page: Page) {
  return terminal(page).evaluate((pre) => {
    let text = "";
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement!;
      if (getComputedStyle(el).opacity === "0") continue;
      text += walker.currentNode.textContent;
    }
    return text;
  });
}

test("the hero terminal types itself out and ends with the full text", async ({
  page,
}) => {
  // Freeze timers so the starting state can't race the animation.
  const start = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.goto("/");
  const box = await terminal(page).boundingBox();

  expect(await visibleText(page)).toBe("");

  await page.clock.resume();
  await expect.poll(() => visibleText(page), { timeout: 5000 }).toBe(finalText);

  // The text was in the DOM all along and the box never resized.
  await expect(terminal(page)).toHaveText(finalText);
  expect(await terminal(page).boundingBox()).toEqual(box);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("shows the full text immediately", async ({ page }) => {
    await page.goto("/");
    expect(await visibleText(page)).toBe(finalText);
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("shows the full text", async ({ page }) => {
    await page.goto("/");
    expect(await visibleText(page)).toBe(finalText);
  });
});
