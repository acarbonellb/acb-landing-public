// The page's sections, in page order: the header nav, the mobile menu, each
// section's heading and the page itself read this list, so they can't drift.
// A section's number is its position, never written by hand.

const registry = [
  { id: "about", nav: "about", title: "about" },
  { id: "stack", nav: "stack", title: "stack" },
  { id: "experience", nav: "experience", title: "experience" },
  { id: "projects", nav: "projects", title: "projects" },
  { id: "agent", nav: "agent", title: "ask my agent" },
  { id: "contact", nav: "contact", title: "contact" },
] as const;

export type SectionId = (typeof registry)[number]["id"];

export type SectionEntry = {
  /** The anchor (`#id`) the nav links to. */
  id: SectionId;
  /** Label in the header nav and the mobile menu. */
  nav: string;
  /** The section's heading. */
  title: string;
  /** "01", "02"…: the position on the page. */
  number: string;
};

export const sections: readonly SectionEntry[] = registry.map((s, i) => ({
  ...s,
  number: String(i + 1).padStart(2, "0"),
}));

export function section(id: SectionId): SectionEntry {
  return sections.find((s) => s.id === id)!;
}
