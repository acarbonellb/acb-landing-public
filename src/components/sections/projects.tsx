import type { AgentPractice, AgentProject } from "@/shared/profile";
import { Section } from "../ui";
import { AgentCard } from "./agent-card";
import { Practices } from "./practices";

export function Projects({
  agents,
  practices,
}: {
  agents: AgentProject[];
  practices: AgentPractice[];
}) {
  return (
    <Section id="projects">
      <div className="grid gap-5 sm:grid-cols-2">
        {agents.map((a) => (
          <AgentCard key={a.slug} agent={a} />
        ))}
      </div>
      <Practices practices={practices} />
    </Section>
  );
}
