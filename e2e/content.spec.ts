import { expect, test } from "./fixtures";

// Literals from the owner's CV (ticket #4): the built page shows the real
// content, not placeholders.

test("shows the real CV content", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: "Alberto Carbonell" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Senior Software Engineer — AI Agents & Full-Stack TypeScript",
    ),
  ).toBeVisible();

  for (const company of ["CoverWallet", "M&GT Consulting", "Indra"]) {
    await expect(page.getByText(`@ ${company}`)).toBeVisible();
  }

  for (const agent of [
    "Fraud Detection Agent",
    "Organizer Support Agent",
    "Portfolio Agent",
  ]) {
    await expect(
      page.getByRole("heading", { name: `./${agent}` }),
    ).toBeVisible();
  }

  // The Portfolio Agent card (#44): eval results from the history, and
  // links to its source and report that stay clickable over the card's link.
  const portfolio = page.getByRole("article", { name: "./Portfolio Agent" });
  await expect(
    portfolio.getByText(/^\d+ eval cases incl\. prompt injection · .* per answer on Claude Haiku 5\.5 · replayed in CI$/),
  ).toBeVisible();
  await expect(portfolio.getByRole("link", { name: /^eval report/ })).toHaveAttribute(
    "href",
    "https://github.com/acarbonellb/acb-landing-public/blob/main/agent/evals/report.md",
  );
  // No network: GitHub answers with a stub.
  await page.context().route("https://github.com/**", (route) => route.fulfill({ body: "ok" }));
  const [source] = await Promise.all([
    page.waitForEvent("popup"),
    portfolio.getByRole("link", { name: /^source/ }).click(),
  ]);
  await source.waitForLoadState();
  expect(source.url()).toBe("https://github.com/acarbonellb/acb-landing-public/tree/main/agent");
  await source.close();
  await expect(page).not.toHaveURL(/#agent$/);

  // How I run agents (#43): four practices, each linked to where it's backed.
  const practices = page.getByRole("region", { name: "how I run agents" });
  for (const title of [
    "Offline evals before shipping",
    "Graded autonomy, a human in the loop",
    "Cost and limits tracked",
    "Changes measured run over run",
  ]) {
    await expect(practices.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(practices.getByRole("link", { name: /ADR 0001/ })).toHaveAttribute(
    "href",
    "https://github.com/acarbonellb/acb-landing-public/blob/main/docs/adr/0001-agent-evals-record-replay.md",
  );
  await practices.getByRole("link", { name: "Fraud Detection Agent" }).click();
  await expect(page).toHaveURL(/#agent-fraud-detection-agent$/);

  const contact = page.locator("#contact");
  await expect(contact.getByText("Drop me a line:", { exact: true })).toBeVisible();

  // Education is left to the CV PDF: no section on the page.
  await expect(page.getByRole("heading", { name: /education/i })).toHaveCount(0);

  await expect(page.locator("body")).not.toContainText(/lorem ipsum/i);
});
