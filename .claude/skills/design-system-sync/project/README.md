A personal portfolio dressed as a developer's terminal: Tokyo Night colours, monospaced type, window chrome and CRT scanlines. Everything should read as if it were printed by a shell, an editor or a git log, while staying accessible and plain to read.

## Content fundamentals

- **Write the UI in English**, in lowercase, as commands and file names: section titles are `about`, `stack`, `experience`, `projects`, `ask my agent`, `contact`; the primary call to action is `./contact.sh`; window titles look like `zsh — whoami`.
- **Borrow real terminal grammar** instead of decorating: `// ` before a comment-style line (`// Spain · Remote`), `> ` before a prompt, `you ›` / `agent ›` / `mcp ›` for speakers in a transcript, `(HEAD -> main)` on the current job, `NORMAL` in the status line, `↗` after any link that leaves the site (`github ↗`).
- **Keep prose short and concrete.** When a card quotes the human voice, switch to `prose-sm` (sans) so it reads as a person talking, not as program output.
- **No emoji.** Glyphs come from the terminal's own set: `›`, `>`, `~`, `●`, `↗`, `—`.

## Colour

- Two themes: **Tokyo Night** (`night`, the default) and **Tokyo Light** (`light`). Every value has both; never hard-code one theme's hex.
- Surfaces step up in three levels: `bg` for the page, `bg-dark` for windows and panels, `bg-highlight` for title bars, hover and selection. Separate them with a 1px `border`, not with shadows.
- Text: `fg` for headings and emphasis, `fg-dark` for body copy, `comment` for anything secondary. All three meet 4.5:1 on `bg` and `bg-dark` in both themes; `comment` was lifted from the original Tokyo Night value for that reason.
- Accents follow syntax highlighting, by meaning: `blue` is the single interactive colour (links, focus, hover, the primary button); `magenta` for keywords and speakers; `cyan` for tags, code and URLs; `green` for strings, bullets and success; `yellow` for hashes and tool calls; `teal` for object keys; `orange` and `red` only for warnings and errors.
- On a solid `blue` or `green` fill, set text in `bg`.

## Type

- **Mono is the default.** `body` is JetBrains Mono (`mono`) in `fg-dark`; most text is `body-sm` (14px).
- **Sans (Geist) is reserved** for the hero name (`hero-name`: semibold, tight tracking, fluid 40–72px), the section numbers, and human-voice prose (`prose-sm`).
- **Pixel (VT323)** appears only in build-time images: the link preview and icons. Do not use it on the page.
- Section titles are `section-title`: a blue number with a dot (`03.`), the lowercase title in `fg`, then a 1px rule fading from `border` to transparent.

## Layout and spacing

- One centred column, `container-page` wide, with a side gutter of `space-4` on phones and `space-6` from the `sm` breakpoint (640px).
- Sections are separated by vertical padding (`space-12` → `space-16`), never by boxes.
- The page sits on a faint dot grid: 1px `border` dots every `space-6` (24px). A fixed overlay of `scanline` stripes sits above everything; keep it non-interactive.
- Spacing follows Tailwind's 4px scale; use the listed steps.

## Windows, borders, shadows and radii

- The signature container is a **window**: `bg-dark` body, `radius-md`, 1px `border`, a title bar in `bg-highlight` with three `radius-full` dots (`red`, `yellow`, `green`, 10px) and a `caption` title in `comment`, plus `retro-shadow`.
- `retro-shadow` (a hard 6px offset in `bg-dark`, no blur) is the only shadow, and goes only on windows and the primary button.
- Small controls (buttons, tags) use `radius-sm` and a 1px `border`. Terminal buttons light up `blue` (border and text) on hover and on keyboard focus.
- Primary button: solid `blue` fill and border, `bg` text, bold, `retro-shadow`, lifts 2px on hover. Secondary: `border` outline, `fg` text, `blue` border on hover.
- Tags: `bg` fill, `border`, `caption` size in `cyan`.

## Motion

- Motion is small and terminal-like: a blinking block cursor in `blue` (1.1s, stepped), a typewriter effect in the hero terminal, 200ms colour transitions on theme change.
- With `prefers-reduced-motion`, the cursor stops, the typewriter shows its full text and scrolling is instant.

## Iconography

- There is no icon library. Use typographic glyphs (above) in the accent colour of their role.
- The site icon (`assets/Brand/icon.svg`) is a `blue` prompt chevron and a `green` cursor bar on a `bg` tile with a `border` outline, fixed to the Tokyo Night values.

## Components

- The components are the site's own code (`src/components`), compiled into `window.Acb`. They are not redrawn copies: what a preview shows is what the site renders.
- The bundle runs on whichever React the page loaded: React 19 here, React 18 on a Design canvas. On a canvas, mount `Acb.Page` or a section with `x-import` and skip this system's `components/lib/` React files.
- `Acb.data` holds the site's real content (profile, experience, skills, projects with eval results, practices), so every section renders with real copy. Pass it as props instead of inventing text.
- To mock up a redesign, start from `Page` (the whole home page) or the section you are changing, and keep everything else real.
- Primitives first: build new surfaces from `Window`, `Section`, `Tag`, `TerminalButton` and `ExternalLink` before writing new markup.
- The agent cannot be reached from here: `Agent` and `Contact` render as on the site, but a question sent from a preview fails.

## Not synced

Taken from `acarbonellb/acb-landing-public` at `12281ce`. Not in this system:

- **Internals without a card:** `ChatNotice`, `ContactAsk`, `ContactFallbackAnswer`, `UsageLine`, `Practices` and `SourceLink` are compiled inside the sections but are not exported on their own.
- **Geist and JetBrains Mono** come from Google Fonts (via `next/font`), so there are no font files for them here; only VT323 is copied.
- **Tailwind variables** under `@theme inline` are aliases of the colour tokens above and are not repeated. `--header-offset` (5rem, the sticky header's scroll offset) is not a design token and was left out.
