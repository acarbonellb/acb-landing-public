import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HomePage } from "@/components/home-page";

export default async function Home() {
  // Read at build time: the Portfolio Agent card shows its latest eval results.
  const evalSummary = await readFile(join(process.cwd(), "agent/evals/summary.json"), "utf8");
  return <HomePage evalSummary={evalSummary} />;
}
