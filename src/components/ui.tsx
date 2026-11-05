import type { ButtonHTMLAttributes, ReactNode } from "react";
import { section, type SectionId } from "@/lib/sections";

// Retro window chrome: title bar with traffic-light dots and a file name.
export function Window({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`retro-shadow overflow-hidden rounded-md border border-border bg-bg-dark ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-border bg-bg-highlight/50 px-3 py-2">
        <span className="size-2.5 rounded-full bg-red" />
        <span className="size-2.5 rounded-full bg-yellow" />
        <span className="size-2.5 rounded-full bg-green" />
        <span className="ml-2 truncate text-xs text-comment">{title}</span>
      </div>
      <div className="p-5 sm:p-6">{children}</div>
    </div>
  );
}

/** A section of the page: its number and title come from the registry. */
export function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const { number, title } = section(id);
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="py-12 sm:py-16"
    >
      <h2
        id={`${id}-title`}
        className="mb-8 flex items-baseline gap-3 text-2xl font-bold text-fg sm:text-3xl"
      >
        <span className="font-sans font-semibold text-blue">
          {number}.
        </span>
        <span>{title}</span>
        <span
          aria-hidden
          className="ml-2 h-px flex-1 self-center bg-gradient-to-r from-border to-transparent"
        />
      </h2>
      {children}
    </section>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-border bg-bg px-2 py-0.5 text-xs text-cyan">
      {children}
    </span>
  );
}

/** A link to another site: opens in a new tab, without a referrer. */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
}

/**
 * A small bordered button in the terminal style, lit blue on hover and focus.
 * `className` adds spacing, layout and the resting text colour.
 */
export function TerminalButton({
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`rounded border border-border text-xs transition-colors hover:border-blue hover:text-blue focus-visible:border-blue focus-visible:text-blue ${className}`}
      {...props}
    />
  );
}
