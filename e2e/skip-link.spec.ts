import { expect, test } from "./fixtures";

// The header is sticky and holds a dozen links: keyboard users skip past it.
test("the first Tab stop skips to the content and moves focus there", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();

  // The next Tab continues inside the content, not back in the header.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("main"))).toBe(true);
});
