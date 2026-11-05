import type { Profile } from "@/shared/profile";
import type { Segment } from "./typewriter-terminal";

/** `{ "key": value, … }` on one line, in the terminal's JSON colours. */
function statusJson(status: Record<string, string | boolean>): Segment[] {
  const punctuation = (text: string): Segment => ({ text, className: "text-fg-dark" });
  return [
    punctuation("{ "),
    ...Object.entries(status).flatMap(([key, value], i) => [
      ...(i > 0 ? [punctuation(", ")] : []),
      { text: JSON.stringify(key), className: "text-teal" },
      punctuation(": "),
      typeof value === "boolean"
        ? { text: String(value), className: "text-orange" }
        : { text: JSON.stringify(value), className: "text-green" },
    ]),
    punctuation(" }"),
  ];
}

// The hero's fake shell session, typed out on load by TypewriterTerminal.
export function heroTerminal(
  profile: Profile,
  status: Record<string, string | boolean>,
): Segment[] {
  return [
    { text: "❯ ", className: "text-green" },
    { text: "whoami", className: "text-blue", typed: true },
    { text: "\n" },
    { text: profile.tagline, className: "text-fg-dark" },
    { text: "\n\n" },
    { text: "❯ ", className: "text-green" },
    { text: "cat", className: "text-blue", typed: true },
    { text: " ", typed: true },
    { text: "status.json", className: "text-yellow", typed: true },
    { text: "\n" },
    ...statusJson(status),
  ];
}
