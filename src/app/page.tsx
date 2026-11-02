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

export default function Home() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-4 sm:px-6">
        <Hero />
        <About />
        <Stack />
        <Experience />
        <Projects />
        <Agent />
        <Contact />
      </main>
      <StatusLine />
    </>
  );
}
