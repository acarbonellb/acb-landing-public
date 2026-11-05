import { json } from "../src/testing/agent-fakes";
import { expect, test } from "./fixtures";

test("loads without console errors", async ({ page, agent }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  // The usage line calls the agent, which isn't running here; the browser
  // would log the refused connection. Answer for it (no line to show).
  await agent.stats(json(200, {}));

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");

  expect(errors).toEqual([]);
});
