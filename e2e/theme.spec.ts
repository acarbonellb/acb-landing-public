import { expect, test } from "@playwright/test";
import { DEFAULT_THEME, THEMES, themeNames, type Theme } from "../src/lib/theme";

// The theme the toggle switches to from the default one.
const other = THEMES.find((t) => t !== DEFAULT_THEME)!;
const switchesTo = (theme: Theme) =>
  new RegExp(`switch to ${themeNames[theme]}$`);

const html = (page: import("@playwright/test").Page) => page.locator("html");
const toggle = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Toggle colour scheme" });

test("opens in the default theme", async ({ page }) => {
  await page.goto("/");

  await expect(html(page)).toHaveAttribute("data-theme", DEFAULT_THEME);
});

test("toggles to the other theme and back", async ({ page }) => {
  await page.goto("/");

  await toggle(page).click();
  await expect(html(page)).toHaveAttribute("data-theme", other);

  await toggle(page).click();
  await expect(html(page)).toHaveAttribute("data-theme", DEFAULT_THEME);
});

test("the toggle's name says which theme it switches to", async ({ page }) => {
  await page.goto("/");

  await expect(toggle(page)).toHaveAccessibleName(switchesTo(other));
  await toggle(page).click();
  await expect(toggle(page)).toHaveAccessibleName(switchesTo(DEFAULT_THEME));
});

test("remembers the chosen theme across reloads", async ({ page }) => {
  await page.goto("/");
  await toggle(page).click();

  await page.reload();

  await expect(html(page)).toHaveAttribute("data-theme", other);
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
  expect(themeAtFirstBody).toBe(other);
});
