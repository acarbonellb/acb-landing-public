import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { DEFAULT_THEME, THEME_STORAGE_KEY, THEMES, type Theme } from "../src/lib/theme";
import { chatError, chatStream, done, mcpContact } from "../src/testing/agent-fakes";
import { ask, conversation, expect, markdownAnswer, test } from "./fixtures";

// Automated accessibility, the one axe spec: axe over the whole page and
// over the chat's states, in both themes (contrast, names, labels, landmarks),
// plus the keyboard path through the chat and the contact button, which axe
// can't judge.
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const EMAIL = "ada@example.test";

async function openIn(page: Page, theme: Theme) {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [THEME_STORAGE_KEY, theme] as const,
  );
  // Reduced motion skips the hero typewriter, so axe sees the final text.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

// Readable failures: rule, impact and the offending selectors.
const summarize = (violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]) =>
  violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(" ")),
  }));

// The CRT scanlines (body::after) and the dot grid are gradients over the
// whole page, so axe can't work out any text's background and skips contrast
// ("incomplete"). They are faint decoration; hide them so contrast is checked
// against the solid theme colours underneath.
const withoutDecoration = (page: Page) =>
  page.addStyleTag({
    content: "body::after { display: none !important } .bg-grid { background-image: none !important }",
  });

// Every WCAG A/AA violation fails, and so does a serious or critical breach of
// axe's best practices.
const fails = (v: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number]) =>
  v.tags.some((t) => WCAG.includes(t)) || v.impact === "serious" || v.impact === "critical";

async function scan(page: Page, include?: string) {
  await withoutDecoration(page);
  const axe = new AxeBuilder({ page }).withTags([...WCAG, "best-practice"]);
  const { violations, incomplete } = await (include ? axe.include(include) : axe).analyze();
  // Contrast must be decided for every text node; only glyph-only nodes
  // (prompt symbols like ❯ and $) may stay undecided.
  const undecided = incomplete
    .filter((r) => r.id === "color-contrast")
    .flatMap((r) => r.nodes)
    .filter((n) => !n.any.some((c) => /non-text characters/.test(c.message)))
    .map((n) => n.target.join(" "));
  return { violations: summarize(violations.filter(fails)), undecided };
}

for (const theme of THEMES) {
  test.describe(`in the ${theme} theme`, () => {
    test("the full page passes axe (WCAG A/AA and serious best practices)", async ({ page }) => {
      await openIn(page, theme);

      const { violations, undecided } = await scan(page);

      expect(violations).toEqual([]);
      expect(undecided).toEqual([]);
    });

    test("the chat's answers and notices pass axe (WCAG A/AA and serious best practices)", async ({ page, agent }) => {
      await agent.chat([
        chatStream(
          { type: "tool_call", id: "t1", name: "get_projects", input: {} },
          { type: "text", delta: markdownAnswer },
          done(),
        ),
        chatError({ code: "rate_limited", message: "Too many questions." }, { headers: { "Retry-After": "30" } }),
        chatError({
          code: "unavailable",
          message: "The chat is resting until next month.",
          resetsAt: "2026-12-01T00:00:00.000Z",
        }),
      ]);
      await openIn(page, theme);
      const notice = page.locator("#agent").getByRole("alert");

      // An answer with a tool call and Markdown, then the rate-limit notice.
      await ask(page, "What has he **built**?");
      await expect(conversation(page).getByRole("link", { name: "GitHub" })).toBeVisible();
      await ask(page, "Hi");
      await expect(notice).toContainText("Rate limit reached.");
      expect(await scan(page, "#agent")).toEqual({ violations: [], undecided: [] });

      // The unavailable notice, with the renewal date and the MCP pointer.
      await ask(page, "Hi again");
      await expect(notice).toContainText("The agent is unavailable right now.");
      expect(await scan(page, "#agent")).toEqual({ violations: [], undecided: [] });
    });

    test("the chat's fallback states pass axe (WCAG A/AA and serious best practices)", async ({ page, agent }) => {
      // The chat is unavailable, so the notice and the MCP answer both render.
      await agent.chat(
        chatError({ code: "unavailable", message: "Resting.", resetsAt: "2026-12-01T00:00:00.000Z" }),
      );
      await agent.mcp(mcpContact(EMAIL));
      await openIn(page, theme);
      await page.locator("#contact").getByRole("button", { name: "ask my agent" }).click();
      const log = conversation(page);
      await expect(log.getByRole("link", { name: EMAIL })).toBeVisible();
      await expect(page.getByRole("alert")).toBeVisible();

      const { violations, undecided } = await scan(page, "#agent");

      expect(violations).toEqual([]);
      expect(undecided).toEqual([]);
    });
  });
}

test("the keyboard reaches the chat and the contact button in reading order", async ({
  page,
}) => {
  await openIn(page, DEFAULT_THEME);
  const input = page.getByRole("textbox", { name: /ask the agent/i });
  const send = page.getByRole("button", { name: /send/i });
  const copy = page.getByRole("button", { name: /copy mcp command/i });
  const ask = page.locator("#contact").getByRole("button", { name: "ask my agent" });

  // Start just before the chat: the conversation log is its first stop.
  await conversation(page).focus();
  for (const next of [input, send, copy]) {
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
  }

  // From the chat's last control, forward Tab reaches the contact button.
  for (let i = 0; i < 20; i++) {
    if (await ask.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(ask).toBeFocused();
  // The focus ring stays visible: some outline or ring is drawn.
  expect(
    await ask.evaluate((el) => {
      const s = getComputedStyle(el);
      return s.outlineStyle !== "none" || s.boxShadow !== "none";
    }),
  ).toBe(true);
});
