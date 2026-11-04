import { expect, test } from "@playwright/test";

test.describe("mobile navigation menu", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("replaces the inline nav and takes the visitor to a section", async ({
    page,
    hasTouch,
  }) => {
    await page.goto("/");

    const menu = page.getByRole("button", { name: "Section menu" });
    await expect(menu).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeHidden();

    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    // Not the first section: that one has focus already when the menu opens.
    const contact = page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("link", { name: /contact/ });
    await (hasTouch ? contact.tap() : contact.click());

    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(page).toHaveURL(/#contact$/);
    await expect(page.locator("#contact")).toBeInViewport();
  });

  test("opens without scrolling the page", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#experience");
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Section menu" }).click();
    await expect(
      page.getByRole("navigation", { name: "Sections" }).getByRole("link").first(),
    ).toBeFocused();

    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  });

  test("is operable from the keyboard", async ({ page }) => {
    await page.goto("/");

    const menu = page.getByRole("button", { name: "Section menu" });
    await menu.focus();
    await page.keyboard.press("Enter");
    const nav = page.getByRole("navigation", { name: "Sections" });
    await expect(nav.getByRole("link").first()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
  });

  test("fits the header without horizontal scroll while open", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Section menu" }).click();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
});

test.describe("at desktop width", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("shows the inline nav and no menu button", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("navigation", { name: "Sections" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Section menu" }),
    ).toBeHidden();
  });
});
