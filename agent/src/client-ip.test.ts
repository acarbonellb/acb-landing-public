import { describe, expect, it } from "vitest";
import { clientIpFrom, mcpClientIpFrom, rateLimitKeyFor } from "./client-ip";

// Hosting's peer, as measured through the live `/mcp` rewrite (in the
// user-triggered fetchers ranges).
const hostingPeer = "66.249.93.229";
// Google-owned (in goog.json) but not a user-triggered fetcher.
const otherGoogle = "66.249.64.1";
// A Google Cloud customer address: anyone can rent one.
const cloudCustomer = "34.1.208.10";

describe("clientIpFrom (/chat, /stats)", () => {
  it("takes the right-most entry (Cloud Run appends the caller)", () => {
    expect(clientIpFrom("198.51.100.1", "10.0.0.1")).toBe("198.51.100.1");
  });

  it("ignores every entry to its left, even after a Hosting peer", () => {
    expect(clientIpFrom("6.6.6.6, 198.51.100.1", "10.0.0.1")).toBe("198.51.100.1");
    expect(clientIpFrom(`198.51.100.1,${hostingPeer}`, "10.0.0.1")).toBe(hostingPeer);
  });

  it("falls back to the socket address without a forwarded entry", () => {
    expect(clientIpFrom(undefined, "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIpFrom(" , ", "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIpFrom("", undefined)).toBe("unknown");
  });
});

describe("mcpClientIpFrom (/mcp)", () => {
  it("takes the right-most entry on a direct call", () => {
    expect(mcpClientIpFrom("198.51.100.1", "10.0.0.1")).toBe("198.51.100.1");
  });

  it("ignores forged entries on a direct call", () => {
    expect(mcpClientIpFrom("6.6.6.6, 198.51.100.1", "10.0.0.1")).toBe("198.51.100.1");
    // Forging a Hosting hop doesn't help: the caller's own IP stays right-most.
    expect(mcpClientIpFrom(`6.6.6.6, ${hostingPeer}, 198.51.100.1`, "10.0.0.1")).toBe(
      "198.51.100.1",
    );
  });

  it("takes the visitor, left of Hosting's fetcher-range peer, through the rewrite", () => {
    expect(mcpClientIpFrom(`198.51.100.1,${hostingPeer}`, "10.0.0.1")).toBe("198.51.100.1");
    expect(mcpClientIpFrom(`2001:db8::1, 66.249.93.199`, "10.0.0.1")).toBe("2001:db8::1");
  });

  it("doesn't treat other Google addresses as Hosting", () => {
    expect(mcpClientIpFrom(`198.51.100.1, ${otherGoogle}`, "10.0.0.1")).toBe(otherGoogle);
    expect(mcpClientIpFrom(`198.51.100.1, ${cloudCustomer}`, "10.0.0.1")).toBe(cloudCustomer);
  });

  it("keeps a fetcher-range caller with nothing to its left", () => {
    expect(mcpClientIpFrom(hostingPeer, "10.0.0.1")).toBe(hostingPeer);
  });

  it("falls back to the socket address without a forwarded entry", () => {
    expect(mcpClientIpFrom(undefined, "127.0.0.1")).toBe("127.0.0.1");
    expect(mcpClientIpFrom("", undefined)).toBe("unknown");
  });
});

describe("rateLimitKeyFor", () => {
  it("keys an IPv6 address on its /64, however it's written", () => {
    expect(rateLimitKeyFor("2001:db8:0:1::1")).toBe("2001:db8:0:1::/64");
    expect(rateLimitKeyFor("2001:0DB8:0000:0001:FFFF:0:0:2")).toBe("2001:db8:0:1::/64");
    expect(rateLimitKeyFor("2001:db8::1:2:3:4")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKeyFor("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKeyFor("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitKeyFor("64:ff9b::198.51.100.1")).toBe("64:ff9b:0:0::/64");
  });

  it("keeps IPv4 addresses, mapped or not, and non-addresses as they are", () => {
    expect(rateLimitKeyFor("198.51.100.1")).toBe("198.51.100.1");
    expect(rateLimitKeyFor("::ffff:198.51.100.1")).toBe("::ffff:198.51.100.1");
    expect(rateLimitKeyFor("unknown")).toBe("unknown");
  });
});
