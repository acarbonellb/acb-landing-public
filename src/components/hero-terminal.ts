import type { Profile } from "@/shared/profile";
import type { Segment } from "./typewriter-terminal";

// The hero's fake shell session, typed out on load by TypewriterTerminal.
export function heroTerminal(profile: Profile): Segment[] {
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
    { text: "{ ", className: "text-fg-dark" },
    { text: '"open_to_work"', className: "text-teal" },
    { text: ": ", className: "text-fg-dark" },
    { text: "true", className: "text-orange" },
    { text: ", ", className: "text-fg-dark" },
    { text: '"focus"', className: "text-teal" },
    { text: ": ", className: "text-fg-dark" },
    { text: '"AI agents"', className: "text-green" },
    { text: " }", className: "text-fg-dark" },
  ];
}
