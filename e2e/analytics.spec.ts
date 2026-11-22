import { readFileSync } from "node:fs";
import { chatStream, done } from "../src/testing/agent-fakes";
import { analyticsBuild, ask, conversation, expect, sdkChunks, test } from "./fixtures";
import { POSTHOG_API_HOST, POSTHOG_ASSETS_HOST } from "../src/lib/posthog-hosts";

// Site analytics (docs/analytics.md). CI tests the build it deploys, which has
// a PostHog key once the repository variable is set: these tests check
// whichever build is under test. The `posthog` fixture stubs PostHog's hosts;
// any request a test doesn't stub is refused (offline.spec.ts).

const isPostHog = (url: string) => {
  const { origin } = new URL(url);
  return origin === POSTHOG_API_HOST || origin === POSTHOG_ASSETS_HOST;
};

test.describe("in a build with a PostHog key", () => {
  test.skip(!analyticsBuild(), "this export was built without NEXT_PUBLIC_POSTHOG_KEY");

  test("loading the page sends a page view to PostHog, with no CSP violation", async ({
    page,
    posthog,
  }) => {
    await page.goto("/");

    await expect.poll(() => posthog.events.map((e) => e.event)).toContain("$pageview");
    const pageview = posthog.events.find((e) => e.event === "$pageview")!;
    expect(pageview.properties.token).toBeTruthy();
  });

  test("the SDK is not in the initial JavaScript: its own chunk loads after the page is interactive", async ({
    page,
    posthog,
  }) => {
    const chunks = sdkChunks();
    expect(chunks).toHaveLength(1);
    const html = readFileSync("out/index.html", "utf8");
    for (const chunk of chunks) expect(html).not.toContain(chunk);

    let loadedAt = 0;
    let sdkRequestedAt = 0;
    page.on("load", () => (loadedAt ||= Date.now()));
    page.on("request", (r) => {
      if (chunks.includes(new URL(r.url()).pathname)) sdkRequestedAt ||= Date.now();
    });
    await page.goto("/");

    await expect.poll(() => posthog.events.length).toBeGreaterThan(0);
    expect(sdkRequestedAt).toBeGreaterThan(0);
    expect(sdkRequestedAt).toBeGreaterThanOrEqual(loadedAt);
  });

  test("no script is loaded from another origin", async ({ page, baseURL, posthog }) => {
    const site = new URL(baseURL!).origin;
    const scripts: string[] = [];
    page.on("request", (r) => {
      if (r.resourceType() === "script" && new URL(r.url()).origin !== site) scripts.push(r.url());
    });
    await page.goto("/");

    await expect.poll(() => posthog.events.length).toBeGreaterThan(0);
    expect(scripts).toEqual([]);
  });

  test("if the SDK fails to load, the page and the chat work as before", async ({
    page,
    agent,
    posthog,
  }) => {
    const chunks = sdkChunks();
    await page.route(
      (url) => chunks.includes(url.pathname),
      (route) => route.abort("blockedbyclient"),
    );
    await agent.chat(chatStream({ type: "text", delta: "He has built three agents." }, done()));
    await page.goto("/");

    await ask(page, "What have you built with agents?");
    await expect(conversation(page).getByText("He has built three agents.")).toBeVisible();
    expect(posthog.events).toEqual([]);
  });
});

test.describe("in a build without a PostHog key", () => {
  test.skip(analyticsBuild(), "this export was built with NEXT_PUBLIC_POSTHOG_KEY");

  test("the page never requests the SDK's chunk and sends nothing to PostHog", async ({
    page,
    posthog,
  }) => {
    const chunks = sdkChunks();
    const requested: string[] = [];
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (chunks.includes(url.pathname) || isPostHog(r.url())) requested.push(r.url());
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    expect(requested).toEqual([]);
    expect(posthog.events).toEqual([]);
  });
});
