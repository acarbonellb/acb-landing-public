// Design System bundle entry: the site's real components, plus the data the
// page passes them, so previews and designs render exactly what the site does.
import { Fragment, type ReactNode } from "react";
import { Header } from "@/components/header";
import { About } from "@/components/sections/about";
import { Agent } from "@/components/sections/agent";
import { AgentCard } from "@/components/sections/agent-card";
import { Contact } from "@/components/sections/contact";
import { Experience } from "@/components/sections/experience";
import { Hero } from "@/components/sections/hero";
import { Projects } from "@/components/sections/projects";
import { Stack } from "@/components/sections/stack";
import { StatusLine } from "@/components/status-line";
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileMenu } from "@/components/mobile-menu";
import { TypewriterTerminal } from "@/components/typewriter-terminal";
import { ChatTranscript } from "@/components/chat-transcript";
import { McpConnect } from "@/components/mcp-connect";
import { Markdown } from "@/components/markdown";
import { ExperienceEntry } from "@/components/experience-entry";
import { heroTerminal } from "@/components/hero-terminal";
import { ExternalLink, Section, Tag, TerminalButton, Window } from "@/components/ui";
import { agentEndpoints } from "@/lib/agent-endpoint";
import { withEvalResults } from "@/lib/eval-results";
import { type SectionId, sections } from "@/lib/sections";
import { practices, agentProjects, experience, profile, skillGroups } from "@/shared/profile";
import { heroStatus } from "@/shared/site-copy";

declare const __EVAL_SUMMARY__: string;

// The deployed site has an agent; artifacts cannot reach it, so the chat
// renders as on the site but its requests fail. The MCP URL shown is the
// site's real public one (production builds show it on the site's domain).
const endpoints = agentEndpoints("https://agent.invalid", "production");

const data = {
  profile,
  experience,
  skillGroups,
  practices,
  agentProjects: withEvalResults(agentProjects, __EVAL_SUMMARY__),
  sections,
  endpoints,
  heroTerminal: heroTerminal(profile, heroStatus),
};

/** The whole home page, composed as src/app/page.tsx does. */
function Page() {
  const content: Record<SectionId, ReactNode> = {
    about: <About summary={profile.summary} />,
    stack: <Stack skillGroups={skillGroups} />,
    experience: <Experience roles={experience} />,
    projects: <Projects agentProjects={data.agentProjects} practices={practices} />,
    agent: <Agent endpoints={endpoints} />,
    contact: <Contact profile={profile} endpoints={endpoints} />,
  };
  return (
    <>
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

const AgentWithDemo = (props: { endpoints?: typeof endpoints }) => (
  <Agent endpoints={props.endpoints === undefined ? endpoints : props.endpoints} />
);
const ContactWithDemo = (props: { profile?: typeof profile; endpoints?: typeof endpoints }) => (
  <Contact
    profile={props.profile ?? profile}
    endpoints={props.endpoints === undefined ? endpoints : props.endpoints}
  />
);

const components = {
  Window,
  Section,
  Tag,
  TerminalButton,
  ExternalLink,
  Header,
  StatusLine,
  ThemeToggle,
  MobileMenu,
  TypewriterTerminal,
  ChatTranscript,
  McpConnect,
  Markdown,
  Hero,
  About,
  Stack,
  Experience,
  ExperienceEntry,
  Projects,
  AgentCard,
  Agent: AgentWithDemo,
  Contact: ContactWithDemo,
  Page,
};

(window as unknown as Record<string, unknown>).Acb = { ...components, data };
