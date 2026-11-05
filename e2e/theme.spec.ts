import { expect, test } from "@playwright/test";

const html = (page: import("@playwright/test").Page) => page.locator("html");
const toggle = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Toggle colour scheme" });

test("opens in Tokyo Night by default", async ({ page }) => {
  await page.goto("/");

  await expect(html(page)).toHaveAttribute("data-theme", "night");
});

test("toggles to Tokyo Light and back", async ({ page }) => {
  await page.goto("/");

  await toggle(page).click();
  await expect(html(page)).toHaveAttribute("data-theme", "light");

  await toggle(page).click();
  await expect(html(page)).toHaveAttribute("data-theme", "night");
});

test("the toggle's name says which theme it switches to", async ({ page }) => {
  await page.goto("/");

  await expect(toggle(page)).toHaveAccessibleName(/switch to Tokyo Light$/);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAccessibleName(/switch to Tokyo Night$/);
});

test("remembers the chosen theme across reloads", async ({ page }) => {
  await page.goto("/");
  await toggle(page).click();

  await page.reload();

  await expect(html(page)).toHaveAttribute("data-theme", "light");
});

test("applies the saved theme before the page body renders (no flash)", async ({
  page,
}) => {
  await page.goto("/");
  await toggle(page).click();

  // Record the theme at the moment <body> is first inserted, before paint.
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (document.body) {
        (window as unknown as { themeAtFirstBody: string | null }).themeAtFirstBody =
          document.documentElement.getAttribute("data-theme");
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.reload();

  const themeAtFirstBody = await page.evaluate(
    () => (window as unknown as { themeAtFirstBody: string | null }).themeAtFirstBody,
  );
  expect(themeAtFirstBody).toBe("light");
});
