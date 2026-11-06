import { describe, expect, it } from "vitest";
import {
  fetcherCheck,
  isUnknownGoogleAddress,
  isUserTriggeredFetcher,
  parseGoogleRanges,
  refreshGoogleRanges,
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

  it("has Hosting's measured peers in the committed snapshot, and not other Google addresses", () => {
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

describe("refreshGoogleRanges", () => {
  const published = (creationTime: string, prefixes: string[]) => ({
    creationTime,
    prefixes: prefixes.map((p) => (p.includes(":") ? { ipv6Prefix: p } : { ipv4Prefix: p })),
  });
  const previous = parseGoogleRanges({
    fetchers: published("2026-10-01T00:00:00", ["192.0.2.0/25", "192.0.2.128/25"]),
    google: published("2026-10-01T00:00:00", ["198.51.100.0/24", "2001:db8::/32"]),
    cloud: published("2026-10-01T00:00:00", ["203.0.113.0/24"]),
  });
  const later = "2026-11-05T00:00:00";

  it("reports no change when only the publication times or the order moved", () => {
    const refresh = refreshGoogleRanges(previous, {
      fetchers: published(later, ["192.0.2.128/25", "192.0.2.0/25"]),
      google: published(later, ["2001:db8::/32", "198.51.100.0/24"]),
      cloud: published(later, ["203.0.113.0/24"]),
    });
    expect(refresh.changed).toBe(false);
  });

  it("reports a change, with the new snapshot, when any list's prefixes changed", () => {
    const refresh = refreshGoogleRanges(previous, {
      fetchers: published(later, ["192.0.2.0/25", "192.0.2.128/25"]),
      google: published(later, ["198.51.100.0/24", "2001:db8::/32"]),
      cloud: published(later, ["203.0.113.0/25", "203.0.113.128/25"]),
    });
    expect(refresh.changed).toBe(true);
    expect(refresh.ranges.cloud).toEqual(["203.0.113.0/25", "203.0.113.128/25"]);
    expect(refresh.ranges.createdAt.cloud).toBe(later);
  });

  it("fails on a download that has lost more than half of a list's prefixes", () => {
    const bigger = parseGoogleRanges({
      fetchers: published("2026-10-01T00:00:00", [
        "192.0.2.0/26",
        "192.0.2.64/26",
        "192.0.2.128/26",
        "192.0.2.192/26",
        "2001:db8:1::/48",
      ]),
      google: published("2026-10-01T00:00:00", previous.google),
      cloud: published("2026-10-01T00:00:00", previous.cloud),
    });
    const downloads = {
      fetchers: published(later, ["192.0.2.0/26", "192.0.2.64/26"]),
      google: published(later, previous.google),
      cloud: published(later, previous.cloud),
    };
    expect(() => refreshGoogleRanges(bigger, downloads)).toThrow(
      "fetchers: 2 prefixes, down from 5",
    );
    // Half of the list is still a plausible refresh.
    expect(
      refreshGoogleRanges(bigger, {
        ...downloads,
        fetchers: published(later, ["192.0.2.0/26", "192.0.2.64/26", "192.0.2.128/26"]),
      }).changed,
    ).toBe(true);
  });

  it("fails on a download that isn't a list of prefixes", () => {
    expect(() =>
      refreshGoogleRanges(previous, {
        fetchers: published(later, previous.fetchers),
        google: "<html>",
        cloud: published(later, previous.cloud),
      }),
    ).toThrow();
  });
});
