import type { SkillGroup } from "@/shared/profile";
import { Section, Window } from "../ui";

export function Stack({ skillGroups }: { skillGroups: SkillGroup[] }) {
  return (
    <Section id="stack">
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
