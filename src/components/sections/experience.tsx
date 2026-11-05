import type { Role } from "@/shared/profile";
import { ExperienceEntry } from "../experience-entry";
import { Section } from "../ui";

export function Experience({ roles }: { roles: Role[] }) {
  return (
    <Section id="experience">
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
