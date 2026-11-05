import { expect, test } from "@playwright/test";

// Literals from the owner's CV: the first role's commit and one highlight.

test.describe("experience diff details", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("expands an entry into its diff and collapses it from the keyboard", async ({
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

    // With every entry expanded the page still fits: layout.spec.ts.
    await show.focus();
    await page.keyboard.press("Enter");
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await expect(highlight).toBeHidden();
  });
});
