The signature container: a retro terminal window with a title bar, three traffic-light dots and a hard offset shadow.

**When to use.** Use it for any self-contained terminal or editor surface: the hero `whoami`, `stack.ts`, the agent chat. Not for plain text blocks or cards (cards use a 1px `border` without the title bar).

**The consumer provides.** `title` (a file or command name in lowercase, e.g. `zsh — whoami`, `stack.ts`), `children`, optional `className` for width and margins (e.g. `max-w-2xl mt-10`). The body pads itself (`space-5` → `space-6`).

Source: `src/components/ui.tsx`. Compiled from the repository, not hand-written.
