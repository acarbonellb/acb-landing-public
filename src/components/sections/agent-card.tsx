import type { AgentProject, AgentStatus } from "@/shared/profile";
import { agentStatusLabels } from "@/shared/site-copy";
import { Tag } from "../ui";
import { SourceLink } from "./source-link";

const statusColour: Record<AgentStatus, string> = {
  "in-progress": "border-yellow text-yellow",
  "offline-evals": "border-green text-green",
  "coming-soon": "border-comment text-comment",
  "personal-project": "border-cyan text-cyan",
};

/**
 * One agent in the projects section. With an `href` the whole card is a link;
 * its heading's id is what a practice links to (`#agent-<slug>`).
 */
export function AgentCard({ agent: a }: { agent: AgentProject }) {
  const headingId = `agent-${a.slug}`;
  return (
    <article
      aria-labelledby={headingId}
      className="group retro-shadow relative flex flex-col rounded-md border border-border bg-bg-dark p-5 transition-all hover:-translate-y-1 hover:border-blue"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 id={headingId} className="font-bold text-fg">
          {a.href ? (
            <a
              href={a.href}
              className="after:absolute after:inset-0 after:content-['']"
            >
              <span className="text-comment">./</span>
              {a.name}
            </a>
          ) : (
            <>
              <span className="text-comment">./</span>
              {a.name}
            </>
          )}
        </h3>
        <div className="flex shrink-0 items-center gap-2">
          {a.status && (
            <span
              className={`rounded border px-2 py-0.5 text-xs ${statusColour[a.status]}`}
            >
              {agentStatusLabels[a.status]}
            </span>
          )}
          {a.href && (
            <span
              aria-hidden
              className="text-comment transition-colors group-hover:text-blue"
            >
              ↗
            </span>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-comment">{a.context}</p>
      <p className="mt-3 flex-1 font-sans text-sm leading-relaxed">
        {a.description}
      </p>
      {a.result && (
        <p className="mt-3 border-l-2 border-green pl-3 font-sans text-sm leading-relaxed text-fg">
          {a.result}
        </p>
      )}
      {a.resultDetail && (
        <p className="mt-1 pl-3.5 font-sans text-xs leading-relaxed text-comment">
          {a.resultDetail}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {a.stack.map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
      </div>
      {a.links && (
        // Above the card's stretched link, so each stays clickable.
        <p className="relative z-10 mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {a.links.map((l) => (
            <SourceLink key={l.href} source={l} />
          ))}
        </p>
      )}
    </article>
  );
}
