import { DEFAULT_THEME, THEMES } from "../src/lib/theme";
import { chatError, chatStream, done, mcpContact } from "../src/testing/agent-fakes";
import { openIn, scan } from "./axe";
import { ask, conversation, expect, markdownAnswer, test } from "./fixtures";

// Automated accessibility: axe over the whole page and
// over the chat's states, in both themes (contrast, names, labels, landmarks),
// plus the keyboard path through the chat and the contact button, which axe
// can't judge. The cookie notice's own checks, on the phone too, are in
// cookie-notice.spec.ts; the helpers are in axe.ts.
const EMAIL = "ada@example.test";

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
