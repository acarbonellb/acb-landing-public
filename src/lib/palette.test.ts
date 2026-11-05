import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nightPalette } from "./palette";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// The Tokyo Night colours as globals.css declares them: `--bg-dark` → `bgDark`.
function cssNightTokens(): Record<string, string> {
  const css = read("src/app/globals.css");
  const block = css.match(/:root,\s*\[data-theme="night"\]\s*\{([^}]*)\}/)?.[1] ?? "";
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) {
    tokens[name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = value.toLowerCase();
  }
  return tokens;
}

describe("nightPalette", () => {
  it("matches the Tokyo Night colour tokens in globals.css", () => {
    const tokens = cssNightTokens();
    expect(Object.keys(tokens).length).toBeGreaterThan(10);
    expect(nightPalette).toEqual(tokens);
  });

  it("is the palette of the favicon", () => {
    const colours = [
      ...read("src/app/icon.svg").matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/gi),
    ].map(([, c]) => c.toLowerCase());
    const { bg, border, blue, green } = nightPalette;
    expect(colours).toEqual([bg, border, blue, green]);
  });
});
