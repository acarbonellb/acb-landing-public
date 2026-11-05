import { Section } from "../ui";

export function About({ summary }: { summary: string[] }) {
  return (
    <Section id="about">
      <div className="max-w-3xl space-y-4 font-sans text-base leading-relaxed sm:text-lg">
        {summary.map((p) => (
          <p key={p.slice(0, 24)}>{p}</p>
        ))}
      </div>
    </Section>
  );
}
