import type { Profile } from "@/shared/profile";
import { heroStatus } from "@/shared/site-copy";
import { heroTerminal } from "../hero-terminal";
import { TypewriterTerminal } from "../typewriter-terminal";
import { ExternalLink, Window } from "../ui";

const secondaryLink =
  "rounded border border-border px-4 py-2 text-fg transition-colors hover:border-blue";

// The page's top: not a numbered section, so not in the registry.
export function Hero({
  profile,
  status = heroStatus,
}: {
  profile: Profile;
  /** The terminal's `status.json`. */
  status?: Record<string, string | boolean>;
}) {
  return (
    <section id="top" className="pt-16 pb-12 sm:pt-24">
      <p className="mb-4 text-sm text-comment">
        {"// "}
        <span>{profile.location}</span>
      </p>
      <h1 className="font-sans text-[clamp(2.5rem,6.5vw,4.5rem)] leading-[1.05] font-semibold tracking-[-0.03em] text-fg">
        {profile.name}
      </h1>
      <p className="mt-4 text-lg text-magenta sm:text-xl">
        <span className="text-comment">&gt; </span>
        {profile.title}
        <span className="cursor" aria-hidden />
      </p>

      <Window title="zsh — whoami" className="mt-10 max-w-2xl">
        <TypewriterTerminal
          className="text-sm leading-relaxed whitespace-pre-wrap"
          segments={heroTerminal(profile, status)}
        />
      </Window>

      <div className="mt-10 flex flex-wrap gap-3 text-sm">
        <a
          href="#contact"
          className="retro-shadow rounded border border-blue bg-blue px-4 py-2 font-bold text-bg transition-transform hover:-translate-y-0.5"
        >
          ./contact.sh
        </a>
        <ExternalLink href={profile.links.github} className={secondaryLink}>
          github ↗
        </ExternalLink>
        <ExternalLink href={profile.links.linkedin} className={secondaryLink}>
          linkedin ↗
        </ExternalLink>
      </div>
    </section>
  );
}
