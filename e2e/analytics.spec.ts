import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { chatError, chatStream, contactAnswer, done, mcpContact } from "../src/testing/agent-fakes";
import { contactQuestion } from "../src/shared/site-copy";
import {
  analyticsBuild,
  ask,
  conversation,
  expect,
  type PostHogStub,
  sdkChunks,
  test,
} from "./fixtures";
import { POSTHOG_API_HOST, POSTHOG_ASSETS_HOST } from "../src/lib/posthog-hosts";

// Site analytics (docs/analytics.md). CI tests the build it deploys, which has
// a PostHog key once the repository variable is set: these tests check
// whichever build is under test. The `posthog` fixture stubs PostHog's hosts;
// any request a test doesn't stub is refused (offline.spec.ts).

const isPostHog = (url: string) => {
  const { origin } = new URL(url);
  return origin === POSTHOG_API_HOST || origin === POSTHOG_ASSETS_HOST;
};

const CHAT_EVENTS = ["chat_question_sent", "chat_question_ended", "mcp_command_copied"];

/** The chat and MCP events the page sent, in order, with their properties. */
const chatEvents = (posthog: PostHogStub): Record<string, unknown>[] =>
  posthog.events
    .filter((e) => CHAT_EVENTS.includes(e.event))
    .map((e) => ({
      event: e.event,
      ...Object.fromEntries(
        Object.entries(e.properties).filter(([key]) => ["source", "outcome", "ms"].includes(key)),
      ),
    }));

/** The "sent" and "ended" events of one question, once both have arrived. */
async function questionEvents(posthog: PostHogStub, count = 1) {
  await expect
    .poll(() => chatEvents(posthog).filter((e) => e.event === "chat_question_ended").length)
    .toBe(count);
  return chatEvents(posthog);
}

const askMyAgent = (page: Page) =>
  page.locator("#contact").getByRole("button", { name: "ask my agent" }).click();

const EMAIL = "ada@example.test";

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

test.describe("chat and MCP events, in a build with a PostHog key", () => {
  test.skip(!analyticsBuild(), "this export was built without NEXT_PUBLIC_POSTHOG_KEY");

  test("a question from the chat's input sends 'sent' and 'ended' with its source, outcome and latency", async ({
    page,
    agent,
    posthog,
  }) => {
    await agent.chat(chatStream({ type: "text", delta: "He has built three agents." }, done()));
    await page.goto("/");
    await ask(page, "What have you built with agents?");

    const events = await questionEvents(posthog);
    expect(events).toEqual([
      { event: "chat_question_sent", source: "input" },
      { event: "chat_question_ended", source: "input", outcome: "end_turn", ms: expect.any(Number) },
    ]);
    expect(events[1].ms as number).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(events[1].ms)).toBe(true);
  });

  test("an answer cut short reports the stream's stop reason", async ({ page, agent, posthog }) => {
    await agent.chat(chatStream({ type: "text", delta: "He has built" }, done("max_tokens")));
    await page.goto("/");
    await ask(page, "What have you built with agents?");

    expect((await questionEvents(posthog))[1]).toMatchObject({ outcome: "max_tokens" });
  });

  for (const [outcome, reply] of [
    ["rate_limited", chatError({ code: "rate_limited", message: "Slow down." })],
    ["unavailable", chatError({ code: "unavailable", message: "Resting." })],
    ["error", "unreachable"],
  ] as const) {
    test(`a question that fails as ${outcome} reports that outcome`, async ({ page, agent, posthog }) => {
      await agent.chat(reply);
      await page.goto("/");
      await ask(page, "What have you built with agents?");

      expect(await questionEvents(posthog)).toEqual([
        { event: "chat_question_sent", source: "input" },
        { event: "chat_question_ended", source: "input", outcome, ms: expect.any(Number) },
      ]);
    });
  }

  test("a question still streaming when the visitor leaves is reported as abandoned", async ({
    page,
    agent,
    posthog,
  }) => {
    await agent.chat(chatStream({ type: "text", delta: "Never seen." }, done()), { hold: true });
    await page.goto("/");
    await ask(page, "What have you built with agents?");
    await expect.poll(() => chatEvents(posthog).length).toBe(1);

    // What the browser fires as the visitor leaves. A real navigation would
    // do, but Playwright can't intercept a beacon from a page being unloaded.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));

    expect(await questionEvents(posthog)).toEqual([
      { event: "chat_question_sent", source: "input" },
      { event: "chat_question_ended", source: "input", outcome: "abandoned", ms: expect.any(Number) },
    ]);
  });

  test("the contact section's button sends the same events with the contact source", async ({
    page,
    agent,
    posthog,
  }) => {
    await agent.chat(contactAnswer(EMAIL));
    await page.goto("/");
    await askMyAgent(page);

    expect(await questionEvents(posthog)).toEqual([
      { event: "chat_question_sent", source: "contact" },
      { event: "chat_question_ended", source: "contact", outcome: "end_turn", ms: expect.any(Number) },
    ]);
  });

  test("a contact question answered by the contact fallback reports it", async ({
    page,
    agent,
    posthog,
  }) => {
    await agent.chat(chatError({ code: "unavailable", message: "Resting." }));
    await agent.mcp(mcpContact(EMAIL));
    await page.goto("/");
    await askMyAgent(page);
    await expect(conversation(page).getByRole("link", { name: EMAIL })).toBeVisible();

    expect(await questionEvents(posthog)).toEqual([
      { event: "chat_question_sent", source: "contact" },
      {
        event: "chat_question_ended",
        source: "contact",
        outcome: "contact_fallback",
        ms: expect.any(Number),
      },
    ]);
  });

  test("copying the MCP command sends its event", async ({ page, context, posthog }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.getByRole("button", { name: /copy mcp command/i }).click();

    await expect.poll(() => chatEvents(posthog)).toEqual([{ event: "mcp_command_copied" }]);
  });

  test("a question asked before the SDK has loaded is reported once it has", async ({
    page,
    agent,
    posthog,
  }) => {
    const chunks = sdkChunks();
    let releaseSdk = () => {};
    const sdkHeld = new Promise<void>((resolve) => (releaseSdk = resolve));
    await page.route(
      (url) => chunks.includes(url.pathname),
      async (route) => {
        await sdkHeld;
        await route.fallback();
      },
    );
    await agent.chat(chatStream({ type: "text", delta: "He has built three agents." }, done()));
    await page.goto("/");
    await ask(page, "What have you built with agents?");
    await expect(conversation(page).getByText("He has built three agents.")).toBeVisible();
    expect(posthog.events).toEqual([]);

    releaseSdk();

    expect(await questionEvents(posthog)).toEqual([
      { event: "chat_question_sent", source: "input" },
      { event: "chat_question_ended", source: "input", outcome: "end_turn", ms: expect.any(Number) },
    ]);
  });

  test("nothing sent to PostHog during a conversation holds a question, an answer or the contact address, autocapture included", async ({
    page,
    context,
    agent,
    posthog,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const question = "Which agents has Alberto shipped lately?";
    const answer = "He has shipped a fraud detection agent.";
    await agent.chat([chatStream({ type: "text", delta: answer }, done()), contactAnswer(EMAIL)]);
    await page.goto("/");

    const input = page.getByRole("textbox", { name: /ask the agent/i });
    await input.click();
    await input.fill(question);
    await page.getByRole("button", { name: /send/i }).click();
    await conversation(page).getByText(answer).click();
    await conversation(page).getByText(question).click();

    await askMyAgent(page);
    const address = conversation(page).getByRole("link", { name: EMAIL });
    await address.evaluate((a) => a.addEventListener("click", (e) => e.preventDefault()));
    await address.click();
    // A click outside the chat: autocapture is on, so the clicks above were seen.
    await page.getByRole("button", { name: /copy mcp command/i }).click();
    await expect.poll(() => posthog.events.map((e) => e.event)).toContain("mcp_command_copied");
    await questionEvents(posthog, 2);
    await expect.poll(() => posthog.events.filter((e) => e.event === "$autocapture").length).toBeGreaterThan(0);

    const sent = posthog.bodies.join("\n");
    for (const text of [question, answer, contactQuestion, EMAIL, "fraud detection"]) {
      expect(sent, text).not.toContain(text);
    }
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

  test("the chat and the MCP copy work the same and send nothing to PostHog", async ({
    page,
    context,
    agent,
    posthog,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const requested: string[] = [];
    page.on("request", (r) => {
      if (isPostHog(r.url())) requested.push(r.url());
    });
    await agent.chat(chatStream({ type: "text", delta: "He has built three agents." }, done()));
    await page.goto("/");

    await ask(page, "What have you built with agents?");
    await expect(conversation(page).getByText("He has built three agents.")).toBeVisible();
    await page.getByRole("button", { name: /copy mcp command/i }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("claude mcp add");
    await page.waitForLoadState("networkidle");

    expect(requested).toEqual([]);
    expect(posthog.events).toEqual([]);
  });
});
