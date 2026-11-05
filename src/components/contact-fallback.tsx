import type { ChatErrorKind } from "@/lib/chat-client";
import type { ContactFallback } from "@/lib/contact-fallback";
import { ExternalLink } from "./ui";

const fallbackReason: Record<ChatErrorKind, string> = {
  rate_limited: "The chat's rate limit was reached",
  unavailable: "The model is unavailable",
  error: "The chat couldn't answer",
};

/** The contact fallback's answer, in the chat's transcript. */
export function ContactFallbackAnswer({ fallback }: { fallback: ContactFallback }) {
  if (fallback.kind === "linkedin") {
    return (
      <p className="text-fg-dark">
        <span className="text-comment">[system]</span> The agent can&apos;t be
        reached right now. You can message me on{" "}
        <ExternalLink
          href={fallback.url}
          className="text-blue underline underline-offset-2 hover:text-cyan"
        >
          LinkedIn
        </ExternalLink>
        .
      </p>
    );
  }
  return (
    <>
      <p className="text-fg-dark">
        <span className="text-comment">[system]</span>{" "}
        {fallbackReason[fallback.reason]}; here&apos;s the answer straight
        from my tools.
      </p>
      <p className="break-words text-fg-dark">
        <span className="text-magenta">mcp ›</span> calling{" "}
        <code className="text-yellow">get_contact()</code>
      </p>
      <p className="[overflow-wrap:anywhere]">
        <span className="text-magenta">mcp ›</span>{" "}
        <span className="text-fg-dark">Email: </span>
        <a
          href={`mailto:${fallback.email}`}
          className="text-blue underline underline-offset-2 hover:text-cyan"
        >
          {fallback.email}
        </a>
      </p>
    </>
  );
}
