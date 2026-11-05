// Google's user-triggered fetchers ranges, to recognise the Firebase Hosting
// hop in front of `/mcp` (see `client-ip.ts`): the #36 probe saw Hosting's
// peer in them. The snapshot is Google's published list; refresh it with
// `pnpm agent:ranges`.
import { BlockList, isIP } from "node:net";
import * as z from "zod";
import snapshot from "./google-ranges.json" with { type: "json" };

export const rangeSource =
  "https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json";

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

export type FetcherRanges = {
  /** `creationTime` of the published list the snapshot was taken from. */
  createdAt: string;
  prefixes: string[];
};

/** The snapshot from the published list, validated (it's a download). */
export function parseFetcherRanges(list: unknown): FetcherRanges {
  const parsed = publishedList.parse(list);
  return {
    createdAt: parsed.creationTime,
    prefixes: parsed.prefixes.map((p) => ("ipv4Prefix" in p ? p.ipv4Prefix : p.ipv6Prefix)),
  };
}

/**
 * Whether an address is in Google's user-triggered fetchers ranges. Anything
 * that isn't an IP address is not.
 */
export function fetcherCheck(ranges: FetcherRanges): (address: string) => boolean {
  const list = new BlockList();
  for (const prefix of ranges.prefixes) {
    const [network, bits] = prefix.split("/");
    list.addSubnet(network, Number(bits), isIP(network) === 6 ? "ipv6" : "ipv4");
  }
  return (address) => {
    const version = isIP(address);
    return version !== 0 && list.check(address, version === 6 ? "ipv6" : "ipv4");
  };
}

/** `fetcherCheck` over the committed snapshot. */
export const isUserTriggeredFetcher = fetcherCheck(snapshot);
