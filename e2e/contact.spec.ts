import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { contactQuestion, profile } from "../src/content/profile";
import { addressForms, findAddresses, maskAddress } from "../src/lib/address-scan";

// Contact goes through the agent (#50): "ask my agent" sends a canned question
// to the chat, with the MCP tools and then LinkedIn as fallbacks. The agent is
// stubbed with route interception; the real one is never called.
const CHAT = "**/chat";
const MCP = "**/mcp";
const EMAIL = "ada@example.test";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sse = (...events: object[]) =>
  events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

async function stub(page: Page, url: string, reply: (route: Route) => Promise<void>) {
  const bodies: unknown[] = [];
  await page.route(url, async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: cors });
    }
    bodies.push(route.request().postDataJSON());
    await reply(route);
  });
  return bodies;
}

const stream =
  (...events: object[]) =>
  (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { ...cors, "Content-Type": "text/event-stream" },
      body: sse(...events),
    });

const json =
  (status: number, body: object) =>
  (route: Route) =>
    route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });

const mcpContact = json(200, {
  jsonrpc: "2.0",
  id: 1,
  result: { structuredContent: { email: EMAIL } },
});

const conversation = (page: Page) => page.getByRole("log", { name: /conversation/i });

async function askMyAgent(page: Page) {
  await page.goto("/");
  await page.locator("#contact").getByRole("button", { name: "ask my agent" }).click();
}

test("'ask my agent' sends the contact question to the chat and links the address", async ({
  page,
}) => {
  const chat = await stub(
    page,
    CHAT,
    stream(
      { type: "tool_call", id: "t1", name: "get_contact", input: {} },
      { type: "text", delta: `You can email Alberto at ${EMAIL}.` },
      { type: "done", stopReason: "end_turn", usage: {} },
    ),
  );

  await askMyAgent(page);

  const log = conversation(page);
  await expect(log.getByText(contactQuestion, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /ask the agent/i })).toBeFocused();
  await expect(page.locator("#agent")).toBeInViewport();
  await expect(log.getByRole("link", { name: EMAIL })).toHaveAttribute("href", `mailto:${EMAIL}`);
  expect(chat).toEqual([{ messages: [{ role: "user", content: contactQuestion }] }]);
});

const unavailable = [
  [
    "503 (spend cap)",
    json(503, {
      error: { code: "unavailable", message: "Resting.", resetsAt: "2026-12-01T00:00:00.000Z" },
    }),
    /the model is unavailable; here's the answer straight from my tools/i,
  ],
  [
    "429",
    json(429, { error: { code: "rate_limited", message: "Too many.", retryAfterSeconds: 30 } }),
    /rate limit was reached; here's the answer straight from my tools/i,
  ],
  [
    "a stream that ends in an unavailable error",
    stream({ type: "error", code: "unavailable", message: "The agent is unavailable." }),
    /the model is unavailable; here's the answer straight from my tools/i,
  ],
] as const;

for (const [what, reply, notice] of unavailable) {
  test(`after a chat ${what}, the address comes from the MCP get_contact tool`, async ({
    page,
  }) => {
    await stub(page, CHAT, reply);
    const mcp = await stub(page, MCP, mcpContact);

    await askMyAgent(page);

    const log = conversation(page);
    await expect(log.getByText(notice)).toBeVisible();
    await expect(log.getByRole("link", { name: EMAIL })).toHaveAttribute("href", `mailto:${EMAIL}`);
    expect(mcp).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_contact", arguments: {} },
      },
    ]);
  });
}

test("links to LinkedIn when both the chat and the MCP server fail", async ({ page }) => {
  await page.route(CHAT, (route) => route.abort("connectionrefused"));
  await page.route(MCP, (route) => route.abort("connectionrefused"));

  await askMyAgent(page);

  await expect(conversation(page).getByRole("link", { name: "LinkedIn" })).toHaveAttribute(
    "href",
    profile.links.linkedin,
  );
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the contact section is a LinkedIn link", async ({ page }) => {
    await page.goto("/");

    const contact = page.locator("#contact");
    await expect(contact.getByRole("link", { name: /linkedin/i })).toHaveAttribute(
      "href",
      profile.links.linkedin,
    );
    await expect(contact.getByRole("button")).toHaveCount(0);
  });
});

// The page no longer needs the address: the exported HTML, RSC payloads and
// JS must hold no address at all, plain or scrambled (#39's obfuscation). The
// real one is in no repo file (#51); with CONTACT_EMAIL set (your shell, never
// CI) its forms are searched for too.
test("the static export contains no contact address in any form", () => {
  const files = readdirSync("out", { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(html|js|txt|json)$/.test(f))
    .map((f) => join("out", f));
  expect(files.some((f) => f.endsWith(".js"))).toBe(true);

  const forms = process.env.CONTACT_EMAIL ? addressForms(process.env.CONTACT_EMAIL) : [];
  const hits = files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const lower = text.toLowerCase();
    return [
      ...findAddresses(text).map((a) => `${file}: ${maskAddress(a)}`),
      ...forms
        .filter(({ value }) => lower.includes(value.toLowerCase()))
        .map(({ label }) => `${file}: ${label}`),
    ];
  });
  expect([...new Set(hits)]).toEqual([]);
});
