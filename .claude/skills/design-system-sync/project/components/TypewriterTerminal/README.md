Terminal text that types its commands on load, while output appears at once like a shell.

**When to use.** The hero's `whoami` window. Screen readers get the full text at once; with reduced motion or no JavaScript all text shows immediately.

**The consumer provides.** `segments`: `{ text, className?, typed? }` runs (colour them with the syntax tokens); `className` for size and wrapping.

Source: `src/components/typewriter-terminal.tsx`. Compiled from the repository, not hand-written.
