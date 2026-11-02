import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const themes = ["night", "light"] as const;

async function openInTheme(page: Page, theme: (typeof themes)[number]) {
  await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  // Audit the final state: axe skips the hero terminal's not-yet-typed
  // (hidden) characters, so wait until its last output is on screen.
  await expect(page.getByText('"AI agents"', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

for (const width of [360, 390]) {
  test.describe(`at ${width}px width`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("has no horizontal scroll", async ({ page }) => {
      await page.goto("/");

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    });

    test("code blocks fit without clipping or inner scroll", async ({
      page,
    }) => {
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

for (const theme of themes) {
  test.describe(`in the ${theme} theme`, () => {
    test("axe finds no serious or critical violations", async ({ page }) => {
      await openInTheme(page, theme);

      const { violations } = await new AxeBuilder({ page }).analyze();
      const severe = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target.join(" ")),
        }));
      expect(severe).toEqual([]);
    });

    test("text meets WCAG AA contrast", async ({ page }) => {
      await openInTheme(page, theme);

      const { violations } = await new AxeBuilder({ page })
        .withRules(["color-contrast"])
        .analyze();
      const failures = violations.flatMap((v) =>
        v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary}`),
      );
      expect(failures).toEqual([]);
    });
  });
}
