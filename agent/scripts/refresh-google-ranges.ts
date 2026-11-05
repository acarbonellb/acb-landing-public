// Refreshes the committed snapshot of Google's published IP ranges
// (`src/google-ranges.json`): the user-triggered fetchers ranges, which the
// `/mcp` rate limit uses to recognise the Firebase Hosting hop, and Google's
// own and Google Cloud ranges, which the hop-drift counter uses to notice
// when that hop has moved outside the fetchers. Usage: pnpm agent:ranges
//
// Rewrites the file only when a list's prefixes changed, and fails, leaving
// it untouched, on a download that isn't a valid, plausible list (see
// `refreshGoogleRanges`). The weekly ranges-refresh workflow relies on both.
import { writeFile } from "node:fs/promises";
import { rangeSources, refreshGoogleRanges } from "../src/google-ranges";
import snapshot from "../src/google-ranges.json" with { type: "json" };

async function download(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const { ranges, changed } = refreshGoogleRanges(snapshot, {
  fetchers: await download(rangeSources.fetchers),
  google: await download(rangeSources.google),
  cloud: await download(rangeSources.cloud),
});
const counts =
  `${ranges.fetchers.length} user-triggered fetcher prefixes (${ranges.createdAt.fetchers}), ` +
  `${ranges.google.length} Google (${ranges.createdAt.google}), ` +
  `${ranges.cloud.length} Google Cloud (${ranges.createdAt.cloud})`;
if (changed) {
  const out = new URL("../src/google-ranges.json", import.meta.url);
  await writeFile(out, `${JSON.stringify(ranges, null, 2)}\n`);
  console.log(`google-ranges.json updated: ${counts}`);
} else {
  console.log(`google-ranges.json unchanged: ${counts}`);
}
