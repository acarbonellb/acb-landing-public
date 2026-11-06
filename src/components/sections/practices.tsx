import type { Practice } from "@/shared/profile";
import { SourceLink } from "./source-link";

// "How I run agents": each practice links where it can be checked.
export function Practices({ practices }: { practices: Practice[] }) {
  return (
    <section aria-labelledby="practices-title" className="mt-10">
      <h3 id="practices-title" className="text-lg font-bold text-fg">
        <span aria-hidden className="text-comment">
          {"// "}
        </span>
        how I run agents
      </h3>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2">
        {practices.map((p) => (
          <li key={p.title} className="border-l-2 border-blue pl-4">
            <p className="font-bold text-fg">{p.title}</p>
            <p className="mt-1 font-sans text-sm leading-relaxed">{p.text}</p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {p.sources.map((s) => (
                <SourceLink key={s.href} source={s} />
              ))}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
