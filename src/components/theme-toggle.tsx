"use client";

import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

// The current theme lives on <html data-theme>, so the button needs no React
// state: CSS picks which label to show and stays in sync with the inline script.
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next: Theme =
      root.getAttribute("data-theme") === "light" ? "night" : "light";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {}
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle colour scheme"
      className="group flex items-center gap-2 rounded border border-border bg-bg-dark px-2.5 py-1 text-xs text-fg-dark transition-colors hover:border-blue hover:text-fg"
    >
      <span className="hidden text-comment sm:inline">:colorscheme</span>
      <span className="text-magenta light:hidden">tokyonight</span>
      <span className="hidden text-magenta light:inline">tokyolight</span>
      <span aria-hidden className="text-yellow light:hidden">
        ☾
      </span>
      <span aria-hidden className="hidden text-orange light:inline">
        ☀
      </span>
    </button>
  );
}
