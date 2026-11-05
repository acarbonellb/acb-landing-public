"use client";

import { THEME_STORAGE_KEY, type Theme, themeNames } from "@/lib/theme";

const label = (target: Theme) => `Toggle colour scheme, switch to ${themeNames[target]}`;

// The current theme lives on <html data-theme>, so the button needs no React
// state: CSS picks which label (visible and screen-reader) to show, so it stays
// in sync with the inline script. Hidden text drops out of the accessible name.
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
      className="group flex items-center gap-2 rounded border border-border bg-bg-dark px-2.5 py-1 text-xs text-fg-dark transition-colors hover:border-blue hover:text-fg"
    >
      {/* Name comes from screen-reader text rather than aria-label, so the
          decorative vim-style label below can't mismatch it (axe), and so CSS
          can name the theme the button switches to. */}
      <span className="sr-only light:hidden">{label("light")}</span>
      <span className="sr-only hidden light:inline">{label("night")}</span>
      <span aria-hidden className="hidden text-comment sm:inline">
        :colorscheme
      </span>
      <span aria-hidden className="text-magenta light:hidden">
        tokyonight
      </span>
      <span aria-hidden className="hidden text-magenta light:inline">
        tokyolight
      </span>
      <span aria-hidden className="text-yellow light:hidden">
        ☾
      </span>
      <span aria-hidden className="hidden text-orange light:inline">
        ☀
      </span>
    </button>
  );
}
