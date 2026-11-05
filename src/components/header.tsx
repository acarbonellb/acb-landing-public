import { profile } from "@/shared/profile";
import { MobileMenu, type NavItem } from "./mobile-menu";
import { ThemeToggle } from "./theme-toggle";

const nav: NavItem[] = [
  { href: "#about", label: "about" },
  { href: "#stack", label: "stack" },
  { href: "#experience", label: "experience" },
  { href: "#projects", label: "projects" },
  { href: "#agent", label: "agent" },
  { href: "#contact", label: "contact" },
];

// Styled like a tmux status bar: session name on the left, windows as tabs.
export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3 sm:px-6">
        <a
          href="#top"
          className="shrink-0 rounded bg-blue px-2 py-0.5 text-sm font-bold text-bg"
        >
          ~/{profile.handle}
        </a>
        <nav
          aria-label="Sections"
          className="hidden flex-1 items-center gap-1 text-sm md:flex">
          {nav.map((item, i) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded px-2 py-0.5 text-fg-dark transition-colors hover:bg-bg-highlight hover:text-fg"
            >
              <span className="text-comment">{i + 1}:</span>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <MobileMenu items={nav} />
        </div>
      </div>
    </header>
  );
}
