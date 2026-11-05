// Google's published IP ranges, in a committed snapshot refreshed with
// `pnpm agent:ranges`:
//
// - the user-triggered fetchers ranges, to recognise the Firebase Hosting hop
//   in front of `/mcp` (see `client-ip.ts`): the #36 probe saw Hosting's peer
//   in them. The only list the rate-limit key depends on.
// - Google's own addresses (`goog.json` minus `cloud.json`, the part Google
//   Cloud customers can rent), only to count `/mcp` requests whose hop is
//   Google's but not a fetcher: the sign the fetchers snapshot is stale
//   (`usage.ts`). Never used for keying.
import { BlockList, isIP } from "node:net";
import * as z from "zod";
import snapshot from "./google-ranges.json" with { type: "json" };

export const rangeSources = {
  fetchers:
    "https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json",
  google: "https://www.gstatic.com/ipranges/goog.json",
  cloud: "https://www.gstatic.com/ipranges/cloud.json",
} as const;

export type RangeList = keyof typeof rangeSources;

const publishedList = z.object({
  creationTime: z.string(),
  prefixes: z
    .array(
      z.union([
        z.object({ ipv4Prefix: z.cidrv4() }),
        z.object({ ipv6Prefix: z.cidrv6() }),
      ]),
    )
    .min(1),
});

/** The snapshot: each list's prefixes, and the `creationTime` it was published with. */
export type GoogleRanges = {
  createdAt: Record<RangeList, string>;
} & Record<RangeList, string[]>;

/** One published list's prefixes, validated (it's a download). */
function parseList(list: unknown) {
  const parsed = publishedList.parse(list);
  return {
    createdAt: parsed.creationTime,
    prefixes: parsed.prefixes.map((p) => ("ipv4Prefix" in p ? p.ipv4Prefix : p.ipv6Prefix)),
  };
}

/** The snapshot from the three published lists, each validated. */
export function parseGoogleRanges(lists: Record<RangeList, unknown>): GoogleRanges {
  const fetchers = parseList(lists.fetchers);
  const google = parseList(lists.google);
  const cloud = parseList(lists.cloud);
  return {
    createdAt: { fetchers: fetchers.createdAt, google: google.createdAt, cloud: cloud.createdAt },
    fetchers: fetchers.prefixes,
    google: google.prefixes,
    cloud: cloud.prefixes,
  };
}

const lists = Object.keys(rangeSources) as RangeList[];

function samePrefixes(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((p) => set.has(p));
}

/**
 * A refresh of `previous` from freshly downloaded lists: the new snapshot,
 * and whether any list's prefixes changed. Publication times and order alone
 * are not a change (Google republishes `goog.json` and `cloud.json` daily).
 */
export function refreshGoogleRanges(
  previous: GoogleRanges,
  downloads: Record<RangeList, unknown>,
): { ranges: GoogleRanges; changed: boolean } {
  const ranges = parseGoogleRanges(downloads);
  // A list that shrank this much is a broken or partial download, not Google
  // retiring most of its addresses in a week.
  for (const name of lists) {
    if (ranges[name].length * 2 < previous[name].length) {
      throw new Error(
        `${name}: ${ranges[name].length} prefixes, down from ${previous[name].length}; refusing the refresh`,
      );
    }
  }
  const changed = lists.some((name) => !samePrefixes(previous[name], ranges[name]));
  return { ranges, changed };
}

/** Whether an address is in `prefixes`. Anything that isn't an IP address is not. */
function prefixCheck(prefixes: string[]): (address: string) => boolean {
  const list = new BlockList();
  for (const prefix of prefixes) {
    const [network, bits] = prefix.split("/");
    list.addSubnet(network, Number(bits), isIP(network) === 6 ? "ipv6" : "ipv4");
  }
  return (address) => {
    const version = isIP(address);
    return version !== 0 && list.check(address, version === 6 ? "ipv6" : "ipv4");
  };
}

/** Whether an address is in Google's user-triggered fetchers ranges. */
export function fetcherCheck(ranges: Pick<GoogleRanges, "fetchers">): (address: string) => boolean {
  return prefixCheck(ranges.fetchers);
}

/**
 * Whether an address is Google's own and not a user-triggered fetcher: in
 * `goog.json`, not in `cloud.json` (anyone can rent those), not a fetcher.
 * Where Hosting's peer would show up if it moved outside the fetchers list.
 */
export function unknownGoogleCheck(
  ranges: Pick<GoogleRanges, "fetchers" | "google" | "cloud">,
): (address: string) => boolean {
  const isFetcher = prefixCheck(ranges.fetchers);
  const isGoogle = prefixCheck(ranges.google);
  const isCloud = prefixCheck(ranges.cloud);
  return (address) => isGoogle(address) && !isCloud(address) && !isFetcher(address);
}

/** `fetcherCheck` over the committed snapshot. */
export const isUserTriggeredFetcher = fetcherCheck(snapshot);

/** `unknownGoogleCheck` over the committed snapshot. */
export const isUnknownGoogleAddress = unknownGoogleCheck(snapshot);
