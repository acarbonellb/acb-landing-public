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
  const history = await readFile(join(process.cwd(), "agent/evals/history.jsonl"), "utf8");
  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-4 sm:px-6">
        <Hero profile={profile} />
        <About summary={profile.summary} />
        <Stack skillGroups={skillGroups} />
        <Experience roles={experience} />
        <Projects agents={withEvalResults(agents, history)} practices={agentPractices} />
        <Agent linkedin={profile.links.linkedin} />
        <Contact profile={profile} />
      </main>
      <StatusLine />
    </>
  );
}
