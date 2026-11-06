// Writes out/firebase.json after `next build`: the committed firebase.json with
// the CSP for this build's inline scripts and agent URL (#93). The deploy uses
// it (`firebase deploy --config out/firebase.json`), and the browser tests
// serve the page with its headers (e2e/fixtures.ts). Run by `pnpm build`,
// whose flag keeps Node quiet about parsing the imported .ts as an ES module.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostingConfig } from "../src/lib/security-headers.ts";

const OUT = "out";

const pages = readdirSync(OUT, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".html"))
  .map((file) => readFileSync(join(OUT, file), "utf8"));
if (pages.length === 0) throw new Error(`No pages in ${OUT}/. Run \`next build\` first.`);

const committed = JSON.parse(readFileSync("firebase.json", "utf8"));
const config = hostingConfig(committed, {
  pages,
  agentUrl: process.env.NEXT_PUBLIC_AGENT_URL || undefined,
});
writeFileSync(join(OUT, "firebase.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote ${OUT}/firebase.json (CSP for ${pages.length} pages).`);
