import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { profile } from "../src/shared/profile";

const finalText = `❯ whoami\n${profile.tagline}\n\n❯ cat status.json\n{ "open_to_work": true, "focus": "AI agents" }`;

// Pieces of the on-screen terminal, as a sighted visitor reads them.
const command = (page: Page) => page.getByText("whoami", { exact: true });
const tagline = (page: Page) => page.getByText(profile.tagline, { exact: true });
const lastOutput = (page: Page) =>
  page.getByText('"AI agents"', { exact: true });

async function expectAllShown(page: Page) {
  await expect(command(page)).toBeVisible();
  await expect(tagline(page)).toBeVisible();
  await expect(lastOutput(page)).toBeVisible();
}

test("the hero terminal types itself out and ends with the full text", async ({
  page,
}) => {
  // Freeze timers so the starting state can't race the animation.
  const start = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.goto("/");
  // Whatever follows the terminal: it moves if the terminal resizes.
  const below = page.getByRole("link", { name: "./contact.sh" });
  const position = await below.boundingBox();

  await expect(command(page)).toBeHidden();
  await expect(tagline(page)).toBeHidden();
  await expect(lastOutput(page)).toBeHidden();
  // Screen readers get the full text from the start.
  // (The snapshot is YAML: whitespace collapsed, quotes escaped.)
  const spoken = (await page.getByRole("main").ariaSnapshot()).replaceAll('\\"', '"');
  expect(spoken).toContain(finalText.replace(/\s+/g, " "));

  await page.clock.resume();
  await expect(lastOutput(page)).toBeVisible({ timeout: 5000 });
  await expectAllShown(page);

  // The box never resized.
  expect(await below.boundingBox()).toEqual(position);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("shows the full text immediately", async ({ page }) => {
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.goto("/");
    await expectAllShown(page);
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("shows the full text", async ({ page }) => {
    await page.goto("/");
    await expectAllShown(page);
  });
});
