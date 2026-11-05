import { describe, expect, it } from "vitest";
import { clientIpFrom, mcpClientIpFrom } from "./client-ip";

// Hosting's peer as measured in #36 (in the user-triggered fetchers ranges).
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
