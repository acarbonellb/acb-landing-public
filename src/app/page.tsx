import { Header } from "@/components/header";
import {
  About,
  Agent,
  Contact,
  Experience,
  Hero,
  Projects,
  Stack,
} from "@/components/sections";
import { StatusLine } from "@/components/status-line";
import {
  agents,
  experience,
  profile,
  skillGroups,
} from "@/content/profile";

export default function Home() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-4 sm:px-6">
        <Hero profile={profile} />
        <About summary={profile.summary} />
        <Stack skillGroups={skillGroups} />
        <Experience roles={experience} />
        <Projects agents={agents} />
        <Agent />
        <Contact profile={profile} />
      </main>
      <StatusLine />
    </>
  );
}
