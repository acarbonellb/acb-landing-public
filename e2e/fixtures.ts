import { readFileSync } from "node:fs";
import { expect, type Page, type Route, test as base } from "@playwright/test";
import type { FakeReply } from "../src/testing/agent-fakes";

// The agent service, stubbed for browser tests: the page calls its chat, MCP
// and stats endpoints from the browser, and `agent` answers them with route
// interception (typed fakes from src/testing/agent-fakes.ts), so the real
// agent is never called. Specs import `test` and `expect` from here.

const ENDPOINTS = { chat: "**/chat", mcp: "**/mcp", stats: "**/stats" } as const;
type Endpoint = keyof typeof ENDPOINTS;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Retry-After",
};

/** A fake answer, or `"unreachable"`: the connection is refused. */
export type AgentReply = FakeReply | "unreachable";

export type Stubbed = {
  /** Bodies of the requests the endpoint got (preflights left out). */
  requests: unknown[];
  /** Lets a held stub answer (see `hold`); a no-op otherwise. */
  release: () => void;
};

export type AgentStub = {
  [E in Endpoint]: (
    /** Served in order; the last one answers every later request. */
    replies: AgentReply | AgentReply[],
    /** Hold every answer until `release()`, to look at the page before it lands. */
    options?: { hold?: boolean },
  ) => Promise<Stubbed>;
};

async function stub(
  page: Page,
  endpoint: Endpoint,
  replies: AgentReply | AgentReply[],
  { hold = false } = {},
): Promise<Stubbed> {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const requests: unknown[] = [];
  let release = () => {};
  const released = hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  await page.route(ENDPOINTS[endpoint], async (route: Route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: cors });
    }
    const body = route.request().postData();
    requests.push(body === null ? undefined : JSON.parse(body));
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    await released;
    if (reply === "unreachable") return route.abort("connectionrefused");
    await route.fulfill({ ...reply, headers: { ...cors, ...reply.headers } });
  });
  return { requests, release };
}

type HostingConfig = {
  hosting: { headers: { source: string; headers: { key: string; value: string }[] }[] };
};

/**
 * The headers Hosting sends with every page (the `**` rule), from the config
 * `pnpm build` writes next to the export and the deploy ships.
 */
export function hostingPageHeaders(): Record<string, string> {
  const config: HostingConfig = JSON.parse(readFileSync("out/firebase.json", "utf8"));
  const rule = config.hosting.headers.find((h) => h.source === "**");
  return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

const violations = new WeakMap<Page, string[]>();

/** The CSP violations the page has reported so far, as "<directive> <blocked URI>". */
export async function cspViolations(page: Page): Promise<string[]> {
  // Violation events are dispatched asynchronously: let pending ones land.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
  return [...(violations.get(page) ?? [])];
}

export const test = base.extend<{ agent: AgentStub; localOnly: void }>({
  // CI builds the page with the production agent URL (it tests the build it
  // deploys), so every request off the local server is refused: an endpoint a
  // test doesn't stub fails as if the agent were down, and never reaches it.
  // The `agent` stubs are page routes, which take precedence over this one.
  localOnly: [
    async ({ context, baseURL }, provide) => {
      const site = new URL(baseURL!).origin;
      await context.route(
        (url) => url.origin !== site,
        (route) => route.abort("connectionrefused"),
      );
      await provide();
    },
    { auto: true },
  ],
  // Pages are served with the Hosting headers, CSP included (`serve` sends
  // none), and a test fails if the page reports a CSP violation.
  page: async ({ page, baseURL }, provide) => {
    const reported: string[] = [];
    violations.set(page, reported);
    await page.exposeFunction("__cspViolation", (v: string) => reported.push(v));
    await page.addInitScript(() =>
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as unknown as { __cspViolation: (v: string) => void }).__cspViolation(
          `${e.effectiveDirective} ${e.blockedURI}`,
        ),
      ),
    );
    const site = new URL(baseURL!).origin;
    const headers = hostingPageHeaders();
    await page.route(
      (url) => url.origin === site,
      async (route) => {
        if (route.request().resourceType() !== "document") return route.fallback();
        const response = await route.fetch();
        await route.fulfill({ response, headers: { ...response.headers(), ...headers } });
      },
    );
    await provide(page);
    expect(reported, "CSP violations").toEqual([]);
  },
  agent: async ({ page }, provide) => {
    await provide({
      chat: (replies, options) => stub(page, "chat", replies, options),
      mcp: (replies, options) => stub(page, "mcp", replies, options),
      stats: (replies, options) => stub(page, "stats", replies, options),
    });
  },
});

export { expect };

/** How far the page scrolls sideways (0 when it fits the viewport). */
export const horizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The chat's transcript. */
export const conversation = (page: Page) => page.getByRole("log", { name: /conversation/i });

/** Type a question into the chat and send it. */
export async function ask(page: Page, question: string) {
  const input = page.getByRole("textbox", { name: /ask the agent/i });
  await input.fill(question);
  await input.press("Enter");
}

/**
 * An answer with every Markdown form the chat renders, an unsafe link and
 * HTML that must stay text, and a long unbroken URL that must wrap.
 */
export const markdownAnswer = [
  "He has built **three** agents:",
  "",
  "- *Fraud Detection Agent*",
  "- Portfolio Agent, served over `MCP`",
  "",
  "Code: [GitHub](https://github.com/acarbonellb) or [this](javascript:alert(1)).",
  'Ignore <img src=x onerror="alert(1)"> and https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/spaces',
].join("\n");
