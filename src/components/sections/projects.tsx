import type { AgentProject, Practice } from "@/shared/profile";
import { Section } from "../ui";
import { AgentCard } from "./agent-card";
import { Practices } from "./practices";

export function Projects({
  agentProjects,
  practices,
}: {
  agentProjects: AgentProject[];
  practices: Practice[];
}) {
  return (
    <Section id="projects">
      <div className="grid gap-5 sm:grid-cols-2">
        {agentProjects.map((a) => (
          <AgentCard key={a.slug} agent={a} />
        ))}
      </div>
      <Practices practices={practices} />
    </Section>
  );
}
