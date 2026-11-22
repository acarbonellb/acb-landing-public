import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, type Page, type Route, test as base } from "@playwright/test";
import { COOKIE_NOTICE_DISMISSED, COOKIE_NOTICE_STORAGE_KEY } from "../src/lib/cookie-notice";
import { POSTHOG_API_HOST, POSTHOG_ASSETS_HOST } from "../src/lib/posthog-hosts";
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

/** One event the page sent PostHog. */
export type PostHogEvent = { event: string; properties: Record<string, unknown> };

export type PostHogStub = {
  /** Every event the page sent, in order. */
  events: PostHogEvent[];
  /** The raw bodies of every request to PostHog, decoded, for checks on what left the page. */
  bodies: string[];
};

/** An event request's body as the SDK sends it: plain, base64 form-encoded or gzipped JSON. */
function decodeBatch(url: URL, body: Buffer): string {
  const compression = url.searchParams.get("compression");
  const gzipped = body[0] === 0x1f && body[1] === 0x8b;
  if (compression === "gzip-js" || gzipped) return gunzipSync(body).toString("utf8");
  const text = body.toString("utf8");
  if (compression === "base64" || text.startsWith("data=")) {
    const data = new URLSearchParams(text).get("data") ?? "";
    return Buffer.from(data, "base64").toString("utf8");
  }
  return text;
}

/**
 * PostHog EU, stubbed like the agent: its two origins answer from here and
 * `events` collects what the page sent. Without this stub `localOnly`
 * refuses them, as a tracker blocker would.
 */
async function stubPostHog(page: Page): Promise<PostHogStub> {
  const stub: PostHogStub = { events: [], bodies: [] };
  // The SDK drops every event from an automated browser (navigator.webdriver,
  // a headless user agent): look like a visitor's browser instead.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined });
  });
  await page.route(
    (url) => url.origin === POSTHOG_API_HOST || url.origin === POSTHOG_ASSETS_HOST,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: postHogCors(request.headers().origin) });
      }
      const body = request.postDataBuffer();
      if (body) {
        const decoded = decodeBatch(url, body);
        stub.bodies.push(decoded);
        if (/^\/(e|i\/v0\/e|batch|capture)\/?$/.test(url.pathname)) {
          const parsed = JSON.parse(decoded);
          const batch = Array.isArray(parsed) ? parsed : (parsed.batch ?? [parsed]);
          stub.events.push(...batch);
        }
      }
      await route.fulfill({
        status: 200,
        headers: { ...postHogCors(request.headers().origin), "Content-Type": "application/json" },
        // Remote config as a new project's: autocapture on (the SDK waits for
        // `autocapture_opt_out` before it starts), no flags.
        body: JSON.stringify(
          url.pathname.startsWith("/flags")
            ? { featureFlags: {}, autocapture_opt_out: false }
            : { status: 1, autocapture_opt_out: false },
        ),
      });
    },
  );
  return stub;
}

const postHogCors = (origin: string | undefined) => ({
  "Access-Control-Allow-Origin": origin ?? "*",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
});

/** Whether this export was built with a PostHog key: its CSP lets the page reach PostHog. */
export const analyticsBuild = () =>
  hostingPageHeaders()["Content-Security-Policy"].includes(POSTHOG_API_HOST);

/** The export's chunks that hold the PostHog SDK, by the version string it carries. */
export function sdkChunks(): string[] {
  const { version } = JSON.parse(readFileSync("node_modules/posthog-js/package.json", "utf8"));
  const dir = "out/_next/static/chunks";
  return readdirSync(dir)
    .filter((file) => file.endsWith(".js") && readFileSync(join(dir, file), "utf8").includes(`"${version}"`))
    .map((file) => `/_next/static/chunks/${file}`);
}

/** The options a spec sets with `test.use`. */
export type Options = {
  /**
   * Whether the `posthog` stub answers PostHog's hosts (the default, so no
   * test logs a refused request) or leaves them refused like every other
   * origin, as a tracker blocker would (offline.spec.ts).
   */
  postHog: "answered" | "refused";
  /**
   * Whether the cookie notice shows on a first visit, or the browser already
   * dismissed it (the default): in a build with a key the notice is fixed
   * over the bottom of the page, where it could cover what a test taps.
   * cookie-notice.spec.ts asks for "shown".
   */
  cookieNotice: "dismissed" | "shown";
};

export const test = base.extend<
  Options & { agent: AgentStub; posthog: PostHogStub; localOnly: void; noticeState: void }
>({
  postHog: ["answered", { option: true }],
  cookieNotice: ["dismissed", { option: true }],
  noticeState: [
    async ({ context, cookieNotice }, provide) => {
      if (cookieNotice === "dismissed") {
        await context.addInitScript(
          ([key, value]) => localStorage.setItem(key, value),
          [COOKIE_NOTICE_STORAGE_KEY, COOKIE_NOTICE_DISMISSED] as const,
        );
      }
      await provide();
    },
    { auto: true },
  ],
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
  // Automatic: in a build with a key every page calls PostHog, so every test
  // has it answered unless it asks for "refused" (then `events` stays empty).
  posthog: [
    async ({ page, postHog }, provide) => {
      await provide(postHog === "answered" ? await stubPostHog(page) : { events: [], bodies: [] });
    },
    { auto: true },
  ],
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
