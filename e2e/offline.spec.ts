import { expect, test } from "./fixtures";

// CI tests the build it deploys, so the page under test is built with the
// production agent URL. Nothing a test leaves unstubbed may reach it:
// the page only ever talks to the local server.

test("never reaches a server other than the site, even an endpoint no test stubbed", async ({
  page,
  baseURL,
}) => {
  const site = new URL(baseURL!).origin;
  const reached: string[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).origin !== site) reached.push(response.url());
  });
  const stats = page.waitForEvent("requestfailed", (r) => r.url().endsWith("/stats"));

  await page.goto("/");

  expect((await stats).failure()).not.toBeNull();
  expect(reached).toEqual([]);
});
