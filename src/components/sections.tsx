import {
  type AgentProject,
  type AgentStatus,
  type Profile,
  type Role,
  type SkillGroup,
} from "@/content/profile";
import { type AgentEndpoints, agentUrls } from "@/lib/agent-endpoint";
import { obfuscateEmail } from "@/lib/obfuscated-email";
import { AgentChat } from "./agent-chat";
import { AgentStats } from "./agent-stats";
import { ContactEmail } from "./contact-email";
import { ExperienceEntry } from "./experience-entry";
import { heroTerminal } from "./hero-terminal";
import { TypewriterTerminal } from "./typewriter-terminal";
import { Section, Tag, Window } from "./ui";

export function Hero({ profile }: { profile: Profile }) {
  return (
    <section id="top" className="pt-16 pb-12 sm:pt-24">
      <p className="mb-4 text-sm text-comment">
        {"// "}
        <span>{profile.location}</span>
      </p>
      <h1 className="font-sans text-[clamp(2.5rem,6.5vw,4.5rem)] leading-[1.05] font-semibold tracking-[-0.03em] text-fg">
        {profile.name}
      </h1>
      <p className="mt-4 text-lg text-magenta sm:text-xl">
        <span className="text-comment">&gt; </span>
        {profile.title}
        <span className="cursor" aria-hidden />
      </p>

      <Window title="zsh — whoami" className="mt-10 max-w-2xl">
        <TypewriterTerminal
          className="text-sm leading-relaxed whitespace-pre-wrap"
          segments={heroTerminal(profile)}
        />
      </Window>

      <div className="mt-10 flex flex-wrap gap-3 text-sm">
        <a
          href="#contact"
          className="retro-shadow rounded border border-blue bg-blue px-4 py-2 font-bold text-bg transition-transform hover:-translate-y-0.5"
        >
          ./contact.sh
        </a>
        <a
          href={profile.links.github}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border px-4 py-2 text-fg transition-colors hover:border-blue"
        >
          github ↗
        </a>
        <a
          href={profile.links.linkedin}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border px-4 py-2 text-fg transition-colors hover:border-blue"
        >
          linkedin ↗
        </a>
      </div>
    </section>
  );
}

export function About({ summary }: { summary: string[] }) {
  return (
    <Section id="about" index="01" title="about">
      <div className="max-w-3xl space-y-4 font-sans text-base leading-relaxed sm:text-lg">
        {summary.map((p) => (
          <p key={p.slice(0, 24)}>{p}</p>
        ))}
      </div>
    </Section>
  );
}

export function Stack({ skillGroups }: { skillGroups: SkillGroup[] }) {
  return (
    <Section id="stack" index="02" title="stack">
      <Window title="stack.ts">
        <pre className="text-sm leading-7 break-words whitespace-pre-wrap">
          <span className="text-magenta">export const</span>{" "}
          <span className="text-blue">stack</span>{" "}
          <span className="text-cyan">=</span> {"{"}
          {skillGroups.map((s) => (
            <span key={s.key}>
              {"\n  "}
              <span className="text-teal">{s.key}</span>: [
              {s.items.map((item, i) => (
                <span key={item}>
                  <span className="text-green">&quot;{item}&quot;</span>
                  {i < s.items.length - 1 ? ", " : ""}
                </span>
              ))}
              ],
            </span>
          ))}
          {"\n}"}
        </pre>
      </Window>
    </Section>
  );
}

export function Experience({ roles }: { roles: Role[] }) {
  return (
    <Section id="experience" index="03" title="experience">
      <p className="mb-6 text-sm text-comment">
        $ git log --career --oneline
      </p>
      <ol className="relative space-y-10 border-l border-border pl-6">
        {roles.map((job, i) => (
          <ExperienceEntry key={job.slug} role={job} head={i === 0} />
        ))}
      </ol>
    </Section>
  );
}

const statusBadge: Record<AgentStatus, { label: string; className: string }> = {
  "in-progress": { label: "in progress", className: "border-yellow text-yellow" },
  "personal-project": {
    label: "personal project",
    className: "border-cyan text-cyan",
  },
};

export function Projects({ agents }: { agents: AgentProject[] }) {
  return (
    <Section id="projects" index="04" title="agents I've built">
      <div className="grid gap-5 sm:grid-cols-2">
        {agents.map((a) => {
          const headingId = `agent-${a.slug}`;
          return (
            <article
              key={a.slug}
              aria-labelledby={headingId}
              className="group retro-shadow relative flex flex-col rounded-md border border-border bg-bg-dark p-5 transition-all hover:-translate-y-1 hover:border-blue"
            >
              <div className="flex items-center justify-between gap-3">
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
                      className={`rounded border px-2 py-0.5 text-xs ${statusBadge[a.status].className}`}
                    >
                      {statusBadge[a.status].label}
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
              <div className="mt-4 flex flex-wrap gap-2">
                {a.stack.map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </Section>
  );
}

// The live chat with the agent service, or a "coming soon" note when the
// build has no agent URL (see `agent-endpoint.ts`).
export function Agent({
  endpoints = agentUrls,
}: {
  endpoints?: AgentEndpoints | null;
}) {
  return (
    <Section id="agent" index="05" title="ask my agent">
      <Window title="agent — claude · tool use">
        {endpoints ? (
          <AgentChat chatUrl={endpoints.chat} mcpUrl={endpoints.mcp} />
        ) : (
          <p className="text-sm leading-relaxed">
            <span className="text-comment">[system]</span>{" "}
            <span className="text-fg-dark">
              Agent coming soon: a chat that answers questions about my
              experience and projects, also open to other agents over MCP.
            </span>
          </p>
        )}
      </Window>
      {endpoints && (
        <div className="mt-3">
          <AgentStats url={endpoints.stats} />
        </div>
      )}
    </Section>
  );
}

export function Contact({ profile }: { profile: Profile }) {
  return (
    <Section id="contact" index="06" title="contact">
      <p className="max-w-2xl font-sans text-lg leading-relaxed">
        {profile.contactNote}
      </p>
      <ContactEmail obfuscated={obfuscateEmail(profile.links.email)} />
    </Section>
  );
}
