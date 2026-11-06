import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chatError, chatStream, done, mcpContact, stats, weekStats } from "../src/testing/agent-fakes";
import { contactQuestion } from "../src/shared/site-copy";
import { themeScript } from "../src/lib/theme";
import { ask, conversation, cspViolations, expect, hostingPageHeaders, test } from "./fixtures";

// The site's security headers (#93) live in out/firebase.json, written by
// `pnpm build`. The `page` fixture serves every page with them, so every spec
// runs under the real CSP; this one checks the headers themselves and walks
// the page's cross-origin calls (chat, stats, contact fallback) under them.

test("the deployed config allows the built theme script by its hash", () => {
  const html = readFileSync("out/index.html", "utf8");
  expect(html).toContain(`<script>${themeScript}</script>`);

  const hash = createHash("sha256").update(themeScript).digest("base64");
  const csp = hostingPageHeaders()["Content-Security-Policy"];
  expect(csp).toMatch(/(^|; )script-src 'self' /);
  expect(csp).toContain(`'sha256-${hash}'`);
});

test("the page is served with the Hosting headers", async ({ page }) => {
  const response = await page.goto("/");

  const headers = response!.headers();
  expect(headers["content-security-policy"]).toBe(hostingPageHeaders()["Content-Security-Policy"]);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});

test("the page, the chat, the usage line and the contact fallback run with no CSP violation", async ({
  page,
  agent,
}) => {
  await agent.stats(stats({ current: weekStats("2026-W45", { answered: 3 }), previous: weekStats("2026-W44") }));
  const chat = await agent.chat([
    chatStream({ type: "text", delta: "He has built three agents." }, done()),
    chatError({ code: "unavailable", message: "Resting.", resetsAt: "2026-12-01T00:00:00.000Z" }),
  ]);
  const mcp = await agent.mcp(mcpContact("ada@example.test"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  // Hydrated: the theme toggle and the usage line are client-rendered.
  await expect(page.getByText(/this week: 3 questions answered/)).toBeVisible();

  await ask(page, "What have you built with agents?");
  const log = conversation(page);
  await expect(log.getByText("He has built three agents.")).toBeVisible();

  await page.locator("#contact").getByRole("button", { name: "ask my agent" }).click();
  await expect(log.getByText(contactQuestion, { exact: true })).toBeVisible();
  await expect(log.getByRole("link", { name: "ada@example.test" })).toBeVisible();

  expect(chat.requests).toHaveLength(2);
  expect(mcp.requests).toHaveLength(1);
  expect(await cspViolations(page)).toEqual([]);
});
