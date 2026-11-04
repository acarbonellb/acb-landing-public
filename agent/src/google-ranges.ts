// Google's own IP ranges, to recognise the Firebase Hosting hop in front of
// `/mcp` (see `client-ip.ts`). The snapshot is Google's published `goog.json`
// (every Google address) and `cloud.json` (the part Google Cloud customers
// can rent); refresh it with `pnpm agent:ranges`.
import { BlockList, isIP } from "node:net";
import * as z from "zod";
import snapshot from "./google-ranges.json" with { type: "json" };

export const rangeSources = {
  google: "https://www.gstatic.com/ipranges/goog.json",
  cloud: "https://www.gstatic.com/ipranges/cloud.json",
} as const;

const publishedList = z.object({
  syncToken: z.string(),
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

export type GoogleRanges = {
  /** `creationTime` of each published list the snapshot was taken from. */
  createdAt: { google: string; cloud: string };
  google: string[];
  cloud: string[];
};

const prefixesOf = (list: z.infer<typeof publishedList>) =>
  list.prefixes.map((p) => ("ipv4Prefix" in p ? p.ipv4Prefix : p.ipv6Prefix));

/** The snapshot from the two published lists, validated (they're downloads). */
export function parseGoogleRanges(google: unknown, cloud: unknown): GoogleRanges {
  const g = publishedList.parse(google);
  const c = publishedList.parse(cloud);
  return {
    createdAt: { google: g.creationTime, cloud: c.creationTime },
    google: prefixesOf(g),
    cloud: prefixesOf(c),
  };
}

function blockList(prefixes: string[]): BlockList {
  const list = new BlockList();
  for (const prefix of prefixes) {
    const [network, bits] = prefix.split("/");
    list.addSubnet(network, Number(bits), isIP(network) === 6 ? "ipv6" : "ipv4");
  }
  return list;
}

/**
 * Whether an address is Google's own: in `goog.json` and not in `cloud.json`.
 * Anything that isn't an IP address is not.
 */
export function googleOwnedCheck(ranges: GoogleRanges): (address: string) => boolean {
  const google = blockList(ranges.google);
  const cloud = blockList(ranges.cloud);
  return (address) => {
    const version = isIP(address);
    if (!version) return false;
    const type = version === 6 ? "ipv6" : "ipv4";
    return google.check(address, type) && !cloud.check(address, type);
  };
}

/** `googleOwnedCheck` over the committed snapshot. */
export const isGoogleOwned = googleOwnedCheck(snapshot);
