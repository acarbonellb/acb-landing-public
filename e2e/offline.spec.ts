import { POSTHOG_API_HOST, POSTHOG_ASSETS_HOST } from "../src/lib/posthog-hosts";
import { analyticsBuild, expect, test } from "./fixtures";

// CI tests the build it deploys, so the page under test is built with the
// production agent URL and, once its variable is set, the PostHog key.
// Nothing a test leaves unstubbed may reach either: the page only ever talks
// to the local server. PostHog stays unanswered here, as for a tracker
// blocker: the `posthog` stub otherwise answers it in every test.
test.use({ postHog: "refused" });

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
  const posthog = analyticsBuild()
    ? page.waitForEvent("requestfailed", (r) =>
        [POSTHOG_API_HOST, POSTHOG_ASSETS_HOST].includes(new URL(r.url()).origin),
      )
    : undefined;

  await page.goto("/");

  expect((await stats).failure()).not.toBeNull();
  if (posthog) expect((await posthog).failure()).not.toBeNull();
  expect(reached).toEqual([]);
});
