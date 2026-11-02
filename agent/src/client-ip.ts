// Which IP a request comes from, for per-IP rate limiting.
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The client IP from `X-Forwarded-For`, trusting only the last
 * `trustedProxyHops` entries: each trusted proxy appends the address it saw,
 * and anything before that is whatever the client sent (spoofable). Cloud
 * Run's front end appends the caller's IP, so the default of 1 takes the last
 * entry; behind another appending proxy (e.g. a Firebase Hosting rewrite)
 * use 2. Without enough entries, falls back to the socket's remote address.
 */
export function clientIpFrom(
  forwardedFor: string | undefined,
  remoteAddress: string | undefined,
  trustedProxyHops: number,
): string {
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.at(-trustedProxyHops) ?? remoteAddress ?? "unknown";
}

export function clientIp(c: Context, trustedProxyHops: number): string {
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    // Not running on the Node server (e.g. `app.request` in a test).
  }
  return clientIpFrom(c.req.header("x-forwarded-for"), remote, trustedProxyHops);
}
