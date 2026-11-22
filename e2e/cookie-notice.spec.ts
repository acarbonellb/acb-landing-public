import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { COOKIE_NOTICE_DISMISSED, COOKIE_NOTICE_STORAGE_KEY } from "../src/lib/cookie-notice";
import { THEMES } from "../src/lib/theme";
import { cookieNoticeText } from "../src/shared/site-copy";
import { openIn, scan } from "./axe";
import { analyticsBuild, expect, horizontalOverflow, test } from "./fixtures";

// The cookie notice (docs/analytics.md#cookie-notice). Like analytics.spec.ts,
// these check whichever build is under test. Runs on Chromium and on the
// iPhone (WebKit) profile, the phone project. Every other spec starts with
// the notice already dismissed (e2e/fixtures.ts); these see a first visit.
test.use({ cookieNotice: "shown" });

const notice = (page: Page) =>
  page.getByRole("region", { name: "Cookie notice" });
const ok = (page: Page) => notice(page).getByRole("button", { name: "[ok]" });

test.describe("in a build with a PostHog key", () => {
  test.skip(!analyticsBuild(), "this export was built without NEXT_PUBLIC_POSTHOG_KEY");

  test("shows on a first visit as one line at the bottom left, outside the main content", async ({ page }) => {
    await page.goto("/");

    await expect(notice(page)).toContainText(cookieNoticeText);
    await expect(page.getByRole("main").getByRole("region", { name: "Cookie notice" })).toHaveCount(0);
    const box = (await notice(page).boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBe(0);
    expect(Math.round(box.y + box.height)).toBe(viewport.height);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    // One line: no taller than one line of its text plus its padding.
    const lineHeight = await notice(page)
      .getByText(cookieNoticeText)
      .evaluate((line) => line.getBoundingClientRect().height);
    expect(box.height).toBeLessThan(lineHeight * 2);
  });

  test("causes no horizontal overflow and no layout shift", async ({ page }) => {
    // Not in the static HTML: it appears after hydration, fixed over the page.
    expect(readFileSync("out/index.html", "utf8")).not.toContain(cookieNoticeText);
    await page.goto("/");
    await expect(notice(page)).toBeVisible();

    expect(await notice(page).evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test("[ok] hides it, and it stays hidden after a reload and on a later visit", async ({ page, context }) => {
    await page.goto("/");
    await ok(page).click();

    await expect(notice(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    // Give hydration time to (wrongly) bring it back.
    await page.waitForLoadState("networkidle");
    await expect(notice(page)).toHaveCount(0);

    // A later visit: a new tab in the same browser.
    const later = await context.newPage();
    await later.goto("/");
    await later.waitForLoadState("networkidle");
    await expect(notice(later)).toHaveCount(0);
    expect(await later.evaluate((key) => localStorage.getItem(key), COOKIE_NOTICE_STORAGE_KEY)).toBe(
      COOKIE_NOTICE_DISMISSED,
    );
  });

  test("[ok] is reachable and operable from the keyboard, with the site's focus style", async ({
    page,
    browserName,
  }) => {
    // WebKit's Tab skips buttons unless the platform setting says otherwise.
    test.skip(browserName === "webkit", "Tab focuses only form fields in WebKit by default");
    await page.goto("/");
    await expect(ok(page)).toBeVisible();

    for (let i = 0; i < 80; i++) {
      if (await ok(page).evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(ok(page)).toBeFocused();
    expect(
      await ok(page).evaluate((el) => {
        const s = getComputedStyle(el);
        return s.outlineStyle !== "none" || s.boxShadow !== "none";
      }),
    ).toBe(true);

    await page.keyboard.press("Enter");
    await expect(notice(page)).toHaveCount(0);
  });

  for (const theme of THEMES) {
    test(`the page passes axe with the notice visible, in the ${theme} theme`, async ({ page }) => {
      await openIn(page, theme);
      await expect(notice(page)).toBeVisible();

      expect(await scan(page)).toEqual({ violations: [], undecided: [] });
    });
  }
});

test.describe("in a build without a PostHog key", () => {
  test.skip(analyticsBuild(), "this export was built with NEXT_PUBLIC_POSTHOG_KEY");

  test("no notice is rendered", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(notice(page)).toHaveCount(0);
  });
});
