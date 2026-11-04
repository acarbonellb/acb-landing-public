// Which IP a request comes from, for per-IP rate limiting.
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { isGoogleOwned } from "./google-ranges";

/**
 * The client IP from `X-Forwarded-For`. Cloud Run's front end appends the
 * address it saw, so the right-most entry can't be forged; anything before it
 * is whatever the caller sent. Through the Firebase Hosting rewrite (`/mcp` on
 * the site's domain) that address is Hosting's, a Google-owned one, and
 * Hosting replaces the header with `<visitor>,<hosting>`, so the entry to its
 * left is the visitor. A direct caller can't fake that hop: their own IP is
 * still right-most. Without an entry, falls back to the socket's address.
 */
export function clientIpFrom(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
  isHostingPeer: (address: string) => boolean = isGoogleOwned,
): string {
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const last = entries.at(-1);
  if (last && entries.length > 1 && isHostingPeer(last)) return entries.at(-2)!;
  return last ?? remoteAddress ?? "unknown";
}

export function clientIp(c: Context): string {
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    // Not running on the Node server (e.g. `app.request` in a test).
  }
  return clientIpFrom(c.req.header("x-forwarded-for"), remote);
}
