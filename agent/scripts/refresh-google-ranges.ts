// Refreshes the committed snapshot of Google's IP ranges
// (`src/google-ranges.json`), which the rate limiter uses to recognise the
// Firebase Hosting hop. Usage: pnpm agent:ranges
import { writeFile } from "node:fs/promises";
import { parseGoogleRanges, rangeSources } from "../src/google-ranges";

async function download(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const ranges = parseGoogleRanges(
  await download(rangeSources.google),
  await download(rangeSources.cloud),
);
const out = new URL("../src/google-ranges.json", import.meta.url);
await writeFile(out, `${JSON.stringify(ranges, null, 2)}\n`);
console.log(
  `google-ranges.json: ${ranges.google.length} Google and ${ranges.cloud.length} Google Cloud prefixes (goog.json ${ranges.createdAt.google}, cloud.json ${ranges.createdAt.cloud})`,
);
