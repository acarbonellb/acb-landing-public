import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

// Browser tests run against the static export in `out/`, so run `pnpm build`
// first. CI builds once and reuses the output.
if (!existsSync("out/index.html")) {
  throw new Error("No static export found in out/. Run `pnpm build` first.");
}

// Override with E2E_PORT when another checkout's server already holds 4173
// (reuseExistingServer would otherwise silently test that other build).
const PORT = Number(process.env.E2E_PORT ?? 4173);

// Use a preinstalled Chromium when one is provided (CHROMIUM_PATH, or the
// sandbox default); otherwise Playwright's own download (`playwright install`).
const sandboxChromium = "/opt/pw-browsers/chromium";
const executablePath =
  process.env.CHROMIUM_PATH ??
  (existsSync(sandboxChromium) ? sandboxChromium : undefined);

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: { executablePath },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `serve out --listen ${PORT} --no-clipboard`,
    // Probe over IPv6 loopback: under WSL a closed IPv4 port times out (~2 min)
    // instead of refusing, which stalls Playwright's "is it up yet?" check.
    url: `http://[::1]:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
});
