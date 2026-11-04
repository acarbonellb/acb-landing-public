import { expect, test } from "@playwright/test";

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

  const contact = page.locator("#contact");
  await expect(contact.getByText("Drop me a line:", { exact: true })).toBeVisible();
  await contact.getByRole("button", { name: "show email" }).click();
  await expect(
    contact.getByRole("link", { name: "alberto.carbonell.beceiro@gmail.com" }),
  ).toHaveAttribute("href", "mailto:alberto.carbonell.beceiro@gmail.com");

  // Education is left to the CV PDF: no section on the page.
  await expect(page.getByRole("heading", { name: /education/i })).toHaveCount(0);

  await expect(page.locator("body")).not.toContainText(/lorem ipsum/i);
});

// Ticket #39: crawlers that read the raw HTML (no JavaScript) must not find
// the contact address; the RSC payload is inlined there too.
test("keeps the contact email out of the served HTML", async ({ request }) => {
  const html = await (await request.get("/")).text();

  expect(html).toContain("show email");
  expect(html).not.toContain("alberto.carbonell.beceiro");
  expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
});
