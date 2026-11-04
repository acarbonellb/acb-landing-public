import { describe, expect, it } from "vitest";
import { clientIpFrom } from "./client-ip";

// Hosting's peer as measured in #36 (in goog.json, not in cloud.json).
const hostingPeer = "66.249.93.229";
// A Google Cloud customer address (in cloud.json): anyone can rent one.
const cloudCustomer = "34.1.208.10";

describe("clientIpFrom", () => {
  it("takes the right-most entry on a direct call (Cloud Run appends the caller)", () => {
    expect(clientIpFrom("198.51.100.1", "10.0.0.1")).toBe("198.51.100.1");
  });

  it("ignores forged entries on a direct call", () => {
    expect(clientIpFrom("6.6.6.6, 198.51.100.1", "10.0.0.1")).toBe("198.51.100.1");
    // Forging a Hosting hop doesn't help: the caller's own IP stays right-most.
    expect(clientIpFrom(`6.6.6.6, ${hostingPeer}, 198.51.100.1`, "10.0.0.1")).toBe(
      "198.51.100.1",
    );
  });

  it("takes the visitor, left of Hosting's Google-owned peer, through the rewrite", () => {
    expect(clientIpFrom(`198.51.100.1,${hostingPeer}`, "10.0.0.1")).toBe("198.51.100.1");
    expect(clientIpFrom(`2001:db8::1, 66.249.93.199`, "10.0.0.1")).toBe("2001:db8::1");
  });

  it("doesn't treat a Google Cloud customer address as Hosting", () => {
    expect(clientIpFrom(`198.51.100.1, ${cloudCustomer}`, "10.0.0.1")).toBe(cloudCustomer);
  });

  it("keeps a Google-owned caller with nothing to its left", () => {
    expect(clientIpFrom(hostingPeer, "10.0.0.1")).toBe(hostingPeer);
  });

  it("falls back to the socket address without a forwarded entry", () => {
    expect(clientIpFrom(undefined, "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIpFrom(" , ", "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIpFrom("", undefined)).toBe("unknown");
  });
});
