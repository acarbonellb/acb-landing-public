import { experience, profile, projects, stack } from "@/content/profile";
import { Section, Tag, Window } from "./ui";

export function Hero() {
  return (
    <section id="top" className="pt-16 pb-12 sm:pt-24">
      <p className="mb-4 text-sm text-comment">
        {"// "}
        {profile.location}
      </p>
      <h1 className="glow-text font-pixel text-6xl leading-none text-fg sm:text-8xl">
        {profile.name}
      </h1>
      <p className="mt-4 text-lg text-magenta sm:text-xl">
        <span className="text-comment">&gt; </span>
        {profile.role}
        <span className="cursor" aria-hidden />
      </p>

      <Window title="zsh — whoami" className="mt-10 max-w-2xl">
        <pre className="text-sm leading-relaxed whitespace-pre-wrap">
          <span className="text-green">❯</span>{" "}
          <span className="text-blue">whoami</span>
          {"\n"}
          <span className="text-fg-dark">{profile.tagline}</span>
          {"\n\n"}
          <span className="text-green">❯</span>{" "}
          <span className="text-blue">cat</span>{" "}
          <span className="text-yellow">status.json</span>
          {"\n"}
          <span className="text-fg-dark">{"{ "}</span>
          <span className="text-teal">&quot;open_to_work&quot;</span>
          <span className="text-fg-dark">: </span>
          <span className="text-orange">true</span>
          <span className="text-fg-dark">, </span>
          <span className="text-teal">&quot;focus&quot;</span>
          <span className="text-fg-dark">: </span>
          <span className="text-green">&quot;AI agents&quot;</span>
          <span className="text-fg-dark">{" }"}</span>
        </pre>
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

export function About() {
  return (
    <Section id="about" index="01" title="about">
      <div className="max-w-3xl space-y-4 font-sans text-base leading-relaxed sm:text-lg">
        {profile.about.map((p) => (
          <p key={p.slice(0, 24)}>{p}</p>
        ))}
      </div>
    </Section>
  );
}

export function Stack() {
  return (
    <Section id="stack" index="02" title="stack">
      <Window title="stack.ts">
        <pre className="overflow-x-auto text-sm leading-7">
          <span className="text-magenta">export const</span>{" "}
          <span className="text-blue">stack</span>{" "}
          <span className="text-cyan">=</span> {"{"}
          {stack.map((s) => (
            <span key={s.group}>
              {"\n  "}
              <span className="text-teal">{s.group}</span>: [
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

export function Experience() {
  return (
    <Section id="experience" index="03" title="experience">
      <p className="mb-6 text-sm text-comment">
        $ git log --career --oneline
      </p>
      <ol className="relative space-y-10 border-l border-border pl-6">
        {experience.map((job, i) => (
          <li key={job.hash} className="relative">
            <span
              aria-hidden
              className={`absolute top-1.5 -left-[29.5px] size-2.5 rounded-full ring-4 ring-bg ${
                i === 0 ? "bg-green" : "bg-comment"
              }`}
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm text-yellow">{job.hash}</span>
              <h3 className="text-lg font-bold text-fg">{job.role}</h3>
              <span className="text-magenta">@ {job.company}</span>
              {i === 0 && (
                <span className="text-xs text-cyan">(HEAD -&gt; main)</span>
              )}
            </div>
            <p className="mt-1 text-xs text-comment">{job.period}</p>
            <p className="mt-3 max-w-3xl font-sans leading-relaxed">
              {job.summary}
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {job.highlights.map((h) => (
                <li key={h} className="flex gap-2">
                  <span className="text-green">+</span>
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function Projects() {
  return (
    <Section id="projects" index="04" title="projects">
      <div className="grid gap-5 sm:grid-cols-2">
        {projects.map((p) => (
          <a
            key={p.name}
            href={p.href}
            className="group retro-shadow flex flex-col rounded-md border border-border bg-bg-dark p-5 transition-all hover:-translate-y-1 hover:border-blue"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-fg">
                <span className="text-comment">./</span>
                {p.name}
              </h3>
              <span className="text-comment transition-colors group-hover:text-blue">
                ↗
              </span>
            </div>
            <p className="mt-3 flex-1 font-sans text-sm leading-relaxed">
              {p.description}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {p.tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </div>
          </a>
        ))}
      </div>
    </Section>
  );
}

// Placeholder for the upcoming "ask my agent" chat (phase 2).
export function Agent() {
  return (
    <Section id="agent" index="05" title="ask my agent">
      <Window title="agent — claude · tool use">
        <div className="space-y-3 text-sm">
          <p>
            <span className="text-comment">[system]</span>{" "}
            <span className="text-fg-dark">
              Lorem ipsum: an agent that answers questions about my experience
              and projects.
            </span>
          </p>
          <p>
            <span className="text-cyan">you ›</span>{" "}
            <span className="text-fg">What have you built with agents?</span>
          </p>
          <p>
            <span className="text-magenta">agent ›</span>{" "}
            <span className="text-fg-dark">
              calling <span className="text-yellow">get_projects()</span>…
            </span>
          </p>
        </div>
        <div className="mt-6 flex items-center gap-2 rounded border border-dashed border-border px-3 py-2 text-sm text-comment">
          <span className="text-green">❯</span>
          <span>coming soon</span>
          <span className="cursor" aria-hidden />
        </div>
      </Window>
    </Section>
  );
}

export function Contact() {
  return (
    <Section id="contact" index="06" title="contact">
      <p className="max-w-2xl font-sans text-lg leading-relaxed">
        Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut enim ad
        minim veniam, quis nostrud exercitation.
      </p>
      <a
        href={`mailto:${profile.links.email}`}
        className="glow-text mt-6 inline-block text-xl font-bold text-blue underline decoration-border underline-offset-8 transition-colors hover:decoration-blue sm:text-2xl"
      >
        {profile.links.email}
      </a>
    </Section>
  );
}
