import { expect, test } from "@playwright/test";
import { profile } from "../src/shared/profile";

const SITE = "https://albertocarbonell.dev";

const meta = (name: string) => `meta[name="${name}"], meta[property="${name}"]`;

test.describe("home page metadata", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("has a title and description from the content module", async ({
    page,
  }) => {
    await expect(page).toHaveTitle(`${profile.name} — ${profile.title}`);
    await expect(page.locator(meta("description"))).toHaveAttribute(
      "content",
      profile.tagline,
    );
  });

  test("declares the canonical URL", async ({ page }) => {
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      SITE,
    );
  });

  test("has Open Graph tags with a preview image", async ({ page }) => {
    await expect(page.locator(meta("og:title"))).toHaveAttribute(
      "content",
      `${profile.name} — ${profile.title}`,
    );
    await expect(page.locator(meta("og:description"))).toHaveAttribute(
      "content",
      profile.tagline,
    );
    await expect(page.locator(meta("og:url"))).toHaveAttribute("content", SITE);
    await expect(page.locator(meta("og:image")).first()).toHaveAttribute(
      "content",
      /^https:\/\/albertocarbonell\.dev\/opengraph-image/,
    );
    await expect(page.locator(meta("og:image:width"))).toHaveAttribute(
      "content",
      "1200",
    );
    await expect(page.locator(meta("og:image:height"))).toHaveAttribute(
      "content",
      "630",
    );
  });

  test("has a large-image Twitter card", async ({ page }) => {
    await expect(page.locator(meta("twitter:card"))).toHaveAttribute(
      "content",
      "summary_large_image",
    );
    await expect(page.locator(meta("twitter:title"))).toHaveAttribute(
      "content",
      `${profile.name} — ${profile.title}`,
    );
    await expect(page.locator(meta("twitter:image")).first()).toHaveAttribute(
      "content",
      /^https:\/\/albertocarbonell\.dev\/(twitter|opengraph)-image/,
    );
  });
});

const pngSize = (bytes: Buffer) => ({
  signature: bytes.subarray(1, 4).toString("ascii"),
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

const pathOf = (url: string) => {
  const { pathname, search } = new URL(url, SITE);
  return pathname + search;
};

test.describe("static SEO files", () => {
  test("serves the Open Graph image as a 1200x630 PNG", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const url = await page
      .locator('meta[property="og:image"]')
      .first()
      .getAttribute("content");

    const res = await request.get(pathOf(url!));
    expect(res.ok()).toBe(true);
    expect(pngSize(await res.body())).toEqual({
      signature: "PNG",
      width: 1200,
      height: 630,
    });
  });

  test("links a custom SVG icon and an apple touch icon", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    const icon = await page
      .locator('link[rel="icon"][type="image/svg+xml"]')
      .getAttribute("href");
    const svg = await request.get(pathOf(icon!));
    expect(svg.ok()).toBe(true);
    expect(await svg.text()).toContain("<svg");

    const apple = await page
      .locator('link[rel="apple-touch-icon"]')
      .getAttribute("href");
    const png = await request.get(pathOf(apple!));
    expect(png.ok()).toBe(true);
    expect(pngSize(await png.body())).toEqual({
      signature: "PNG",
      width: 180,
      height: 180,
    });
  });

  test("no longer ships the default framework favicon", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await expect(
      page.locator('link[rel="icon"][href*="favicon.ico"]'),
    ).toHaveCount(0);
    expect((await request.get("/favicon.ico")).status()).toBe(404);
  });

  test("serves robots.txt allowing all crawlers and pointing at the sitemap", async ({
    request,
  }) => {
    const res = await request.get("/robots.txt");
    expect(res.ok()).toBe(true);
    const body = await res.text();
    expect(body).toMatch(/User-Agent: \*/i);
    expect(body).toContain("Allow: /");
    expect(body).not.toMatch(/Disallow: \/\s*$/m);
    expect(body).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  test("serves a sitemap listing the home page", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.ok()).toBe(true);
    const body = await res.text();
    expect(body).toContain("<urlset");
    expect(body).toContain(`<loc>${SITE}</loc>`);
  });
});
