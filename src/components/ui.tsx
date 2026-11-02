import type { ReactNode } from "react";

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

export function Section({
  id,
  index,
  title,
  children,
}: {
  id: string;
  index: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="py-12 sm:py-16">
      <h2 className="mb-8 flex items-baseline gap-3 text-2xl font-bold text-fg sm:text-3xl">
        <span className="font-pixel text-3xl text-blue sm:text-4xl">
          {index}.
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
