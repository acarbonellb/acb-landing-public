// Refreshes the committed snapshot of Google's published IP ranges
// (`src/google-ranges.json`): the user-triggered fetchers ranges, which the
// `/mcp` rate limit uses to recognise the Firebase Hosting hop, and Google's
// own and Google Cloud ranges, which the hop-drift counter uses to notice
// when that hop has moved outside the fetchers. Usage: pnpm agent:ranges
import { writeFile } from "node:fs/promises";
import { parseGoogleRanges, rangeSources } from "../src/google-ranges";

async function download(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const ranges = parseGoogleRanges({
  fetchers: await download(rangeSources.fetchers),
  google: await download(rangeSources.google),
  cloud: await download(rangeSources.cloud),
});
const out = new URL("../src/google-ranges.json", import.meta.url);
await writeFile(out, `${JSON.stringify(ranges, null, 2)}\n`);
console.log(
  `google-ranges.json: ${ranges.fetchers.length} user-triggered fetcher prefixes (${ranges.createdAt.fetchers}), ` +
    `${ranges.google.length} Google (${ranges.createdAt.google}), ` +
    `${ranges.cloud.length} Google Cloud (${ranges.createdAt.cloud})`,
);
