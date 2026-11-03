import { Suspense } from "react";
import { Header } from "@/components/header";
import { PrototypeSwitcher } from "@/components/prototype-switcher";
import {
  About,
  Agent,
  Contact,
  Education,
  Experience,
  Hero,
  Projects,
  Stack,
} from "@/components/sections";
import { StatusLine } from "@/components/status-line";
import {
  agents,
  education,
  experience,
  languages,
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
        <Education education={education} languages={languages} />
        <Agent />
        <Contact profile={profile} />
      </main>
      <StatusLine />
      <Suspense>
        <PrototypeSwitcher />
      </Suspense>
    </>
  );
}
