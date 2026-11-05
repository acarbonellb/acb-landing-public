// Which IP a request comes from, and the key its per-IP rate limits use.
import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { isUserTriggeredFetcher } from "./google-ranges";

const forwardedEntries = (forwardedFor: string | undefined) =>
  (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * The client IP from `X-Forwarded-For`. Cloud Run's front end appends the
 * address it saw, so the right-most entry can't be forged; anything before it
 * is whatever the caller sent. Without an entry, falls back to the socket's
 * address. `/chat` and `/stats`, never behind Firebase Hosting, use this.
 */
export function clientIpFrom(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
): string {
  return forwardedEntries(forwardedFor).at(-1) ?? remoteAddress ?? "unknown";
}

/**
 * The client IP of a `/mcp` request, which may come through the Firebase
 * Hosting rewrite. There the right-most address is Hosting's, in Google's
 * user-triggered fetchers ranges, and Hosting replaces the header with
 * `<visitor>,<hosting>`, so the entry to its left is the visitor. Only that
 * range skips the hop: a direct caller from anywhere else (any other Google
 * address included) is keyed on their own IP.
 */
export function mcpClientIpFrom(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
  isHostingPeer: (address: string) => boolean = isUserTriggeredFetcher,
): string {
  const entries = forwardedEntries(forwardedFor);
  const last = entries.at(-1);
  if (last && entries.length > 1 && isHostingPeer(last)) return entries.at(-2)!;
  return clientIpFrom(forwardedFor, remoteAddress);
}

// A trailing dotted IPv4 (`::ffff:192.0.2.1`) is the last two groups.
function ipv4TailToGroups(group: string): string[] {
  if (!group.includes(".")) return [group];
  const [a, b, c, d] = group.split(".").map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

/** A valid IPv6 address's eight groups, as numbers, with `::` expanded. */
function ipv6Groups(address: string): number[] {
  const groups = (part: string) => (part ? part.split(":") : []).flatMap(ipv4TailToGroups);
  const [head, tail] = address.includes("::") ? address.split("::") : ["", address];
  const left = groups(head);
  const right = groups(tail);
  return [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right].map(
    (group) => parseInt(group, 16),
  );
}

/**
 * The rate-limit key for a client IP: an IPv6 address is keyed on its `/64`
 * prefix, the block one subscriber is usually given, so rotating addresses
 * inside it doesn't buy a fresh window. IPv4 addresses (IPv4-mapped IPv6 ones
 * too, which all sit in `::/64`) and anything that isn't an IP are keyed as
 * they are.
 */
export function rateLimitKeyFor(ip: string): string {
  const address = ip.split("%")[0];
  if (isIP(address) !== 6) return ip;
  const groups = ipv6Groups(address);
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isIpv4Mapped) return ip;
  const prefix = groups.slice(0, 4).map((group) => group.toString(16));
  return `${prefix.join(":")}::/64`;
}

function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // Not running on the Node server (e.g. `app.request` in a test).
    return undefined;
  }
}

/** The `/chat` and `/stats` rate-limit key: the client IP, or its `/64`. */
export function rateLimitKey(c: Context): string {
  return rateLimitKeyFor(clientIpFrom(c.req.header("x-forwarded-for"), remoteAddress(c)));
}

/** The `/mcp` rate-limit key: the visitor's IP, or its `/64`, through the rewrite too. */
export function mcpRateLimitKey(c: Context): string {
  return rateLimitKeyFor(mcpClientIpFrom(c.req.header("x-forwarded-for"), remoteAddress(c)));
}
