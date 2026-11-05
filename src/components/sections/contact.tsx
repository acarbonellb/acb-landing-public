import { type AgentEndpoints, agentUrls } from "@/lib/agent-endpoint";
import type { Profile } from "@/shared/profile";
import { ContactAsk } from "../contact-ask";
import { Section } from "../ui";

export function Contact({
  profile,
  endpoints = agentUrls,
}: {
  profile: Profile;
  endpoints?: AgentEndpoints | null;
}) {
  return (
    <Section id="contact">
      <p className="max-w-2xl font-sans text-lg leading-relaxed">
        {profile.contactNote}
      </p>
      <ContactAsk linkedin={profile.links.linkedin} mcpUrl={endpoints?.mcpDirect} />
    </Section>
  );
}
