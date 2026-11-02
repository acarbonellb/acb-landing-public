import { describe, expect, it } from "vitest";
import { clientIpFrom } from "./client-ip";

describe("clientIpFrom", () => {
  it("takes the entry appended by the outermost trusted proxy", () => {
    expect(clientIpFrom("198.51.100.1", "10.0.0.1", 1)).toBe("198.51.100.1");
    expect(clientIpFrom("6.6.6.6, 198.51.100.1", "10.0.0.1", 1)).toBe("198.51.100.1");
    expect(clientIpFrom("6.6.6.6, 198.51.100.1, 35.0.0.1", "10.0.0.1", 2)).toBe(
      "198.51.100.1",
    );
  });

  it("falls back to the socket address without enough forwarded entries", () => {
    expect(clientIpFrom(undefined, "127.0.0.1", 1)).toBe("127.0.0.1");
    expect(clientIpFrom("198.51.100.1", "127.0.0.1", 2)).toBe("127.0.0.1");
    expect(clientIpFrom("", undefined, 1)).toBe("unknown");
  });
});
