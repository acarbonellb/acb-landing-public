A small bordered button in terminal style that lights up blue on hover and keyboard focus.

**When to use.** Secondary actions inside terminal surfaces: `copy`, `send ↵`, `+ git show …`. The primary call to action is not a TerminalButton (see `Hero`).

**The consumer provides.** All button attributes; `className` adds spacing and the resting text colour (usually `px-2 py-0.5 text-fg-dark`). Labels are lowercase commands.

Source: `src/components/ui.tsx`. Compiled from the repository, not hand-written.
