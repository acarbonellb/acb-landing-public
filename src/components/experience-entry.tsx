"use client";

import { useId, useState } from "react";
import { formatPeriod, type Role } from "@/shared/profile";

// One commit in the `git log` experience timeline. Collapsed it shows the
// commit line and summary; the `git show` button discloses the role's stack and
// highlights rendered as a diff. The details stay in the HTML (hidden) so the
// static page keeps the full content.
export function ExperienceEntry({ role, head }: { role: Role; head: boolean }) {
  const [open, setOpen] = useState(false);
  const buttonId = useId();
  const detailsId = useId();

  return (
    <li className="relative">
      <span
        aria-hidden
        className={`absolute top-1.5 -left-[29.5px] size-2.5 rounded-full ring-4 ring-bg ${
          head ? "bg-green" : "bg-comment"
        }`}
      />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-yellow">{role.hash}</span>
        <h3 className="text-lg font-bold text-fg">{role.role}</h3>
        <span className="text-magenta">@ {role.company}</span>
        {head && <span className="text-xs text-cyan">(HEAD -&gt; main)</span>}
      </div>
      <p className="mt-1 text-xs text-comment">
        {`${formatPeriod(role.period)} · ${role.place}`}
      </p>
      {role.description && (
        <p className="mt-3 max-w-3xl font-sans leading-relaxed">
          {role.description}
        </p>
      )}

      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((o) => !o)}
        className="mt-3 inline-flex items-center gap-2 rounded border border-border px-2 py-1 text-xs text-comment transition-colors hover:border-blue hover:text-blue focus-visible:border-blue focus-visible:text-blue"
      >
        <span aria-hidden className="text-green">
          {open ? "−" : "+"}
        </span>
        <span>{`git show ${role.hash}`}</span>
      </button>

      <div
        id={detailsId}
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
        className="mt-3 max-w-3xl rounded-md border border-border bg-bg-dark p-4 text-sm leading-relaxed break-words"
      >
        <p className="text-comment">{`@@ stack @@`}</p>
        <ul className="mb-3 flex flex-wrap gap-x-4">
          {role.stack.map((t) => (
            <li key={t} className="flex gap-2">
              <span aria-hidden className="text-green">
                +
              </span>
              <span className="text-green">{t}</span>
            </li>
          ))}
        </ul>
        <p className="text-comment">{`@@ highlights @@`}</p>
        <ul className="space-y-1">
          {role.highlights.map((h) => (
            <li key={h} className="flex gap-2">
              <span aria-hidden className="shrink-0 text-green">
                +
              </span>
              <span className="min-w-0 text-green">{h}</span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}
