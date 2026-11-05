import type { PracticeSource } from "@/shared/profile";
import { ExternalLink } from "../ui";

/** A link to a section of this page (`#...`), as opposed to another site. */
const isOnPage = (href: string) => href.startsWith("#");

const className = "text-blue underline-offset-4 hover:underline";

/**
 * A card's or a practice's link: one to this page stays in the tab; one to
 * another site opens a new tab and says so with ↗.
 */
export function SourceLink({ source: { label, href } }: { source: PracticeSource }) {
  return isOnPage(href) ? (
    <a href={href} className={className}>
      {label}
    </a>
  ) : (
    <ExternalLink href={href} className={className}>
      {label} ↗
    </ExternalLink>
  );
}
