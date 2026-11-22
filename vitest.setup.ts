import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetAnalytics } from "@/lib/analytics";

// Every test starts as a build without a PostHog key, whatever the shell's
// NEXT_PUBLIC_POSTHOG_KEY; a test that needs one calls resetAnalytics itself.
beforeEach(() => resetAnalytics(undefined));

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
