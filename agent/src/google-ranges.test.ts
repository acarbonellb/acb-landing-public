import { describe, expect, it } from "vitest";
import { fetcherCheck, isUserTriggeredFetcher, parseFetcherRanges } from "./google-ranges";

const list = (prefixes: object[]) => ({
  creationTime: "2026-11-04T15:46:00.000000",
  prefixes,
});

describe("Google's user-triggered fetchers ranges", () => {
  const isFetcher = fetcherCheck(
    parseFetcherRanges(list([{ ipv4Prefix: "66.249.93.0/24" }, { ipv6Prefix: "2001:4860:4801:4004::/64" }])),
  );

  it("counts addresses in the published prefixes", () => {
    expect(isFetcher("66.249.93.229")).toBe(true);
    expect(isFetcher("2001:4860:4801:4004::1")).toBe(true);
  });

  it("doesn't count other addresses or non-addresses", () => {
    expect(isFetcher("66.249.64.1")).toBe(false);
    expect(isFetcher("2001:db8::1")).toBe(false);
    expect(isFetcher("unknown")).toBe(false);
  });

  it("rejects a download that isn't a list of prefixes", () => {
    expect(() => parseFetcherRanges(list([]))).toThrow();
    expect(() => parseFetcherRanges(list([{ ipv4Prefix: "not-a-prefix" }]))).toThrow();
    expect(() => parseFetcherRanges("<html>")).toThrow();
  });

  it("has Hosting's peers from #36 in the committed snapshot, and not other Google addresses", () => {
    expect(isUserTriggeredFetcher("66.249.93.229")).toBe(true);
    expect(isUserTriggeredFetcher("66.249.93.199")).toBe(true);
    expect(isUserTriggeredFetcher("66.249.64.1")).toBe(false);
    expect(isUserTriggeredFetcher("8.8.8.8")).toBe(false);
  });
});
