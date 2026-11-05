import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Header } from "@/components/header";
import {
  About,
  Agent,
  Contact,
  Experience,
  Hero,
  Projects,
  Stack,
} from "@/components/sections";
import { StatusLine } from "@/components/status-line";
import {
  agentPractices,
  agents,
  experience,
  profile,
  skillGroups,
} from "@/content/profile";
import { withEvalResults } from "@/lib/eval-results";

export default async function Home() {
  // Read at build time: the Portfolio Agent card shows its latest eval results.
  const evalFile = (name: string) => readFile(join(process.cwd(), "agent/evals", name), "utf8");
  const [history, report] = await Promise.all([evalFile("history.jsonl"), evalFile("report.md")]);
  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-4 sm:px-6">
        <Hero profile={profile} />
        <About summary={profile.summary} />
        <Stack skillGroups={skillGroups} />
        <Experience roles={experience} />
        <Projects agents={withEvalResults(agents, { history, report })} practices={agentPractices} />
        <Agent linkedin={profile.links.linkedin} />
        <Contact profile={profile} />
      </main>
      <StatusLine />
    </>
  );
}
