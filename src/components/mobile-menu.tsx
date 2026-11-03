"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";

export type NavItem = { href: string; label: string };

// Small-screen section navigation, styled as a terminal drop-down window.
// Disclosure pattern: the button toggles a panel of plain links. Opening moves
// focus to the first link, arrows cycle through them, Escape closes and hands
// focus back to the button, and leaving the menu (focus or tap outside) or
// choosing a section closes it.
export function MobileMenu({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector("a")?.focus();

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function links() {
    return Array.from(panelRef.current?.querySelectorAll("a") ?? []);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    const all = links();
    const current = all.indexOf(document.activeElement as HTMLAnchorElement);
    const target = {
      ArrowDown: current + 1,
      ArrowUp: current - 1,
      Home: 0,
      End: all.length - 1,
    }[event.key];
    if (target === undefined || all.length === 0) return;
    event.preventDefault();
    all[(target + all.length) % all.length].focus();
  }

  function onBlur(event: FocusEvent) {
    if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative md:hidden"
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label="Section menu"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded border border-border bg-bg-dark px-2.5 py-1 text-xs text-fg-dark transition-colors hover:border-blue hover:text-fg aria-expanded:border-blue aria-expanded:text-fg"
      >
        <span className="text-comment">:</span>
        <span className="text-cyan">ls</span>
        <span aria-hidden className="text-comment">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <nav
          ref={panelRef}
          id={panelId}
          aria-label="Sections"
          className="absolute right-0 top-full mt-2 w-56 overflow-hidden rounded border border-border bg-bg-dark text-sm shadow-lg shadow-black/30"
        >
          <p
            aria-hidden
            className="border-b border-border bg-bg-highlight px-3 py-1 text-xs text-comment"
          >
            <span className="text-green">~</span> ls sections/
          </p>
          <ul className="py-1">
            {items.map((item, i) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="group flex items-center gap-2 px-3 py-2 text-fg-dark outline-none transition-colors hover:bg-bg-highlight hover:text-fg focus-visible:bg-bg-highlight focus-visible:text-fg"
                >
                  <span
                    aria-hidden
                    className="text-green opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                  >
                    ❯
                  </span>
                  <span className="text-comment">{i + 1}:</span>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
