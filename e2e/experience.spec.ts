import { expect, test } from "@playwright/test";

// Literals from the owner's CV: the first role's commit and one highlight.

test.describe("experience diff details", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("expands an entry into its diff without horizontal scroll", async ({
    page,
  }) => {
    await page.goto("/");

    const show = page.getByRole("button", { name: "git show a1f3c9e" });
    const highlight = page.getByText(
      "Integrated third-party insurance carrier APIs into the core platform.",
    );

    await expect(show).toHaveAttribute("aria-expanded", "false");
    await expect(highlight).toBeHidden();

    await show.click();

    await expect(show).toHaveAttribute("aria-expanded", "true");
    await expect(highlight).toBeVisible();

    // Expand every entry, then check the page still fits the viewport.
    for (const button of await page
      .getByRole("button", { name: /^git show / })
      .all()) {
      if ((await button.getAttribute("aria-expanded")) === "false") {
        await button.click();
      }
    }
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);

    await show.focus();
    await page.keyboard.press("Enter");
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await expect(highlight).toBeHidden();
  });
});
