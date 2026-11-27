A numbered page section: the h2 shows its two-digit number in blue, its lowercase title and a fading rule.

**When to use.** Every top-level section of the page goes in one. Number and title come from the section registry (`src/lib/sections.ts`), so the order is never written by hand.

**The consumer provides.** `id` (one of `about`, `stack`, `experience`, `projects`, `agent`, `contact`) and `children`. Vertical padding `space-12` → `space-16`.

Source: `src/components/ui.tsx`. Compiled from the repository, not hand-written.
