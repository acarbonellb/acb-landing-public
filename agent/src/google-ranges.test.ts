import { describe, expect, it } from "vitest";
import {
  fetcherCheck,
  isUnknownGoogleAddress,
  isUserTriggeredFetcher,
  parseGoogleRanges,
  unknownGoogleCheck,
} from "./google-ranges";

const list = (prefixes: object[]) => ({
  creationTime: "2026-11-04T15:46:00.000000",
  prefixes,
});

const ranges = parseGoogleRanges({
  fetchers: list([{ ipv4Prefix: "66.249.93.0/24" }, { ipv6Prefix: "2001:4860:4801:4004::/64" }]),
  google: list([
    { ipv4Prefix: "66.249.64.0/19" },
    { ipv4Prefix: "34.0.0.0/8" },
    { ipv6Prefix: "2001:4860::/32" },
  ]),
  cloud: list([{ ipv4Prefix: "34.1.208.0/20" }]),
});

describe("Google's user-triggered fetchers ranges", () => {
  const isFetcher = fetcherCheck(ranges);

  it("counts addresses in the published prefixes", () => {
    expect(isFetcher("66.249.93.229")).toBe(true);
    expect(isFetcher("2001:4860:4801:4004::1")).toBe(true);
  });

  it("doesn't count other addresses or non-addresses", () => {
    expect(isFetcher("66.249.64.1")).toBe(false);
    expect(isFetcher("2001:db8::1")).toBe(false);
    expect(isFetcher("unknown")).toBe(false);
  });

  it("has Hosting's peers from #36 in the committed snapshot, and not other Google addresses", () => {
    expect(isUserTriggeredFetcher("66.249.93.229")).toBe(true);
    expect(isUserTriggeredFetcher("66.249.93.199")).toBe(true);
    expect(isUserTriggeredFetcher("66.249.64.1")).toBe(false);
    expect(isUserTriggeredFetcher("8.8.8.8")).toBe(false);
  });
});

describe("Google addresses outside the fetchers ranges", () => {
  const isUnknownGoogle = unknownGoogleCheck(ranges);

  it("counts Google's own addresses that aren't fetchers", () => {
    expect(isUnknownGoogle("66.249.64.1")).toBe(true);
    expect(isUnknownGoogle("2001:4860:1::1")).toBe(true);
  });

  it("doesn't count fetchers, Google Cloud customer addresses, others or non-addresses", () => {
    expect(isUnknownGoogle("66.249.93.229")).toBe(false);
    expect(isUnknownGoogle("2001:4860:4801:4004::1")).toBe(false);
    expect(isUnknownGoogle("34.1.208.10")).toBe(false);
    expect(isUnknownGoogle("198.51.100.1")).toBe(false);
    expect(isUnknownGoogle("unknown")).toBe(false);
  });

  it("uses the committed snapshot of both lists", () => {
    expect(isUnknownGoogleAddress("66.249.64.1")).toBe(true);
    expect(isUnknownGoogleAddress("66.249.93.229")).toBe(false);
    expect(isUnknownGoogleAddress("198.51.100.1")).toBe(false);
  });
});

describe("parseGoogleRanges", () => {
  const good = list([{ ipv4Prefix: "66.249.93.0/24" }]);

  it("rejects a download that isn't a list of prefixes, in any of the lists", () => {
    expect(() => parseGoogleRanges({ fetchers: list([]), google: good, cloud: good })).toThrow();
    expect(() =>
      parseGoogleRanges({
        fetchers: good,
        google: list([{ ipv4Prefix: "not-a-prefix" }]),
        cloud: good,
      }),
    ).toThrow();
    expect(() => parseGoogleRanges({ fetchers: good, google: good, cloud: "<html>" })).toThrow();
  });

  it("keeps each list's prefixes and publication time", () => {
    const createdAt = "2026-11-04T15:46:00.000000";
    expect(parseGoogleRanges({ fetchers: good, google: good, cloud: good })).toEqual({
      createdAt: { fetchers: createdAt, google: createdAt, cloud: createdAt },
      fetchers: ["66.249.93.0/24"],
      google: ["66.249.93.0/24"],
      cloud: ["66.249.93.0/24"],
    });
  });
});
