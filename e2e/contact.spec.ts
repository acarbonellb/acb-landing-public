import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { profile } from "../src/shared/profile";
import { addressForms, findAddresses, maskAddress } from "../repo-hygiene/address-scan";

// Contact goes through the agent, so the page never shows the address: "ask
// my agent" sends a canned question to the chat, with the MCP tools and then LinkedIn as fallbacks. The whole
// fallback matrix is unit-tested (src/components/contact-ask.test.tsx); the
// browsers run one happy path and one fallback (contact-mobile.spec.ts). This
// spec checks what holds without the chat.

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
// JS must hold no address at all, plain or scrambled (scrapers once
// harvested it from the page). The real one is in no repo file, as the repo
// is public; with CONTACT_EMAIL set (your shell, never
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
