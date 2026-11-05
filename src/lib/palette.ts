// Tokyo Night as hex values, for the build-time images (preview image, icons)
// that can't read CSS variables. globals.css is the source; palette.test.ts
// fails when the two (or icon.svg) disagree.
export const nightPalette = {
  bg: "#1a1b26",
  bgDark: "#16161e",
  bgHighlight: "#292e42",
  border: "#2f3549",
  fg: "#c0caf5",
  fgDark: "#a9b1d6",
  comment: "#8f96b9",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
  orange: "#ff9e64",
  yellow: "#e0af68",
  green: "#8fa876",
  teal: "#73daca",
  red: "#f7768e",
} as const;
