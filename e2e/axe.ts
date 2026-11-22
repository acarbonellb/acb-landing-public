import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { THEME_STORAGE_KEY, type Theme } from "../src/lib/theme";
import { expect } from "./fixtures";

// The axe helpers a11y.spec.ts and cookie-notice.spec.ts share.
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Open the page in `theme`, with reduced motion. */
export async function openIn(page: Page, theme: Theme) {
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

/** Axe over the page (or `include`): the failing violations and the text whose contrast stayed undecided. */
export async function scan(page: Page, include?: string) {
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
