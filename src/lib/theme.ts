// The colour schemes, named once: the inline script in layout.tsx, the toggle
// and the browser tests all read them from here.
export const THEME_STORAGE_KEY = "theme";

export const THEMES = ["night", "light"] as const;

export type Theme = (typeof THEMES)[number];

/** The theme the page opens in when nothing is saved. */
export const DEFAULT_THEME: Theme = "night";

/** How the toggle names each theme (its vim-style label and screen-reader text). */
export const themeNames: Record<Theme, string> = {
  night: "Tokyo Night",
  light: "Tokyo Light",
};

/**
 * Applies the saved theme before first paint to avoid a flash. Inlined in the
 * page's head by layout.tsx; the CSP allows it by hash (security-headers.ts).
 */
export const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(${JSON.stringify(THEMES)}.indexOf(t)>=0)document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
