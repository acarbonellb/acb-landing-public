// Refreshes the committed snapshot of Google's user-triggered fetchers ranges
// (`src/google-ranges.json`), which the `/mcp` rate limit uses to recognise
// the Firebase Hosting hop. Usage: pnpm agent:ranges
import { writeFile } from "node:fs/promises";
import { parseFetcherRanges, rangeSource } from "../src/google-ranges";

const res = await fetch(rangeSource);
if (!res.ok) throw new Error(`${rangeSource} answered ${res.status}`);
const ranges = parseFetcherRanges(await res.json());
const out = new URL("../src/google-ranges.json", import.meta.url);
await writeFile(out, `${JSON.stringify(ranges, null, 2)}\n`);
console.log(
  `google-ranges.json: ${ranges.prefixes.length} user-triggered fetcher prefixes (${ranges.createdAt})`,
);
