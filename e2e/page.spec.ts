import { expect, test } from "@playwright/test";

test("loads without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  // The usage line calls the agent, which isn't running here; the browser
  // would log the refused connection. Answer for it (no line to show).
  await page.route("**/stats", (route) =>
    route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: {} }),
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");

  expect(errors).toEqual([]);
});

test.describe("at mobile width", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("has no horizontal scroll", async ({ page }) => {
    await page.goto("/");

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
});
