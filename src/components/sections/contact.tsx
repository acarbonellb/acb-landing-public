import type { Profile } from "@/shared/profile";
import { ContactAsk } from "../contact-ask";
import { Section } from "../ui";

export function Contact({ profile }: { profile: Profile }) {
  return (
    <Section id="contact">
      <p className="max-w-2xl font-sans text-lg leading-relaxed">
        {profile.contactNote}
      </p>
      <ContactAsk linkedin={profile.links.linkedin} />
    </Section>
  );
}
