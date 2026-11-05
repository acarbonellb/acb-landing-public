import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Fragment, type ReactNode } from "react";
import { Header } from "@/components/header";
import { About } from "@/components/sections/about";
import { Agent } from "@/components/sections/agent";
import { Contact } from "@/components/sections/contact";
import { Experience } from "@/components/sections/experience";
import { Hero } from "@/components/sections/hero";
import { Projects } from "@/components/sections/projects";
import { Stack } from "@/components/sections/stack";
import { StatusLine } from "@/components/status-line";
import { withEvalResults } from "@/lib/eval-results";
import { type SectionId, sections } from "@/lib/sections";
import {
  practices,
  agentProjects,
  experience,
  profile,
  skillGroups,
} from "@/shared/profile";

export default async function Home() {
  // Read at build time: the Portfolio Agent card shows its latest eval results.
  const evalFile = (name: string) => readFile(join(process.cwd(), "agent/evals", name), "utf8");
  const [history, report] = await Promise.all([evalFile("history.jsonl"), evalFile("report.md")]);
  // Each registered section's content; the registry sets the order.
  const content: Record<SectionId, ReactNode> = {
    about: <About summary={profile.summary} />,
    stack: <Stack skillGroups={skillGroups} />,
    experience: <Experience roles={experience} />,
    projects: (
      <Projects agentProjects={withEvalResults(agentProjects, { history, report })} practices={practices} />
    ),
    agent: <Agent />,
    contact: <Contact profile={profile} />,
  };
  return (
    <>
      {/* First Tab stop: jumps past the sticky header. `main` takes focus
          (tabIndex -1), so the next Tab continues inside the content. */}
      <a
        href="#main"
        className="sr-only rounded bg-blue px-3 py-1 text-sm font-bold text-bg focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60]"
      >
        Skip to content
      </a>
      <Header />
      <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 outline-none sm:px-6">
        <Hero profile={profile} />
        {sections.map((s) => (
          <Fragment key={s.id}>{content[s.id]}</Fragment>
        ))}
      </main>
      <StatusLine />
    </>
  );
}
