// Which IP a request comes from, for per-IP rate limiting.
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

function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // Not running on the Node server (e.g. `app.request` in a test).
    return undefined;
  }
}

export function clientIp(c: Context): string {
  return clientIpFrom(c.req.header("x-forwarded-for"), remoteAddress(c));
}

export function mcpClientIp(c: Context): string {
  return mcpClientIpFrom(c.req.header("x-forwarded-for"), remoteAddress(c));
}
