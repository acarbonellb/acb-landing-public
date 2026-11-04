import { describe, expect, it } from "vitest";
import { googleOwnedCheck, parseGoogleRanges } from "./google-ranges";

const list = (prefixes: object[]) => ({
  syncToken: "1",
  creationTime: "2026-11-04T12:08:41.147787",
  prefixes,
});

describe("Google's IP ranges", () => {
  const ranges = parseGoogleRanges(
    list([{ ipv4Prefix: "34.0.0.0/15" }, { ipv4Prefix: "66.249.64.0/19" }, { ipv6Prefix: "2001:4860::/32" }]),
    list([{ ipv4Prefix: "34.1.208.0/20", service: "Google Cloud", scope: "africa-south1" }]),
  );
  const isGoogleOwned = googleOwnedCheck(ranges);

  it("counts addresses in goog.json that aren't in cloud.json as Google's own", () => {
    expect(isGoogleOwned("66.249.93.229")).toBe(true);
    expect(isGoogleOwned("34.0.0.1")).toBe(true);
    expect(isGoogleOwned("2001:4860::8888")).toBe(true);
  });

  it("doesn't count Google Cloud customer addresses, other addresses or non-addresses", () => {
    expect(isGoogleOwned("34.1.208.10")).toBe(false);
    expect(isGoogleOwned("198.51.100.1")).toBe(false);
    expect(isGoogleOwned("2001:db8::1")).toBe(false);
    expect(isGoogleOwned("unknown")).toBe(false);
  });

  it("rejects a download that isn't a list of prefixes", () => {
    expect(() => parseGoogleRanges(list([]), list([{ ipv4Prefix: "1.2.3.0/24" }]))).toThrow();
    expect(() =>
      parseGoogleRanges(list([{ ipv4Prefix: "not-a-prefix" }]), list([{ ipv4Prefix: "1.2.3.0/24" }])),
    ).toThrow();
    expect(() => parseGoogleRanges("<html>", list([{ ipv4Prefix: "1.2.3.0/24" }]))).toThrow();
  });
});
