import { describe, expect, it } from "vitest";
import { isNumber } from "./is-number";

describe("isNumber", () => {
  it("accepts finite numbers", () => {
    for (const value of [0, -1, 0.0165, 1e6]) expect(isNumber(value)).toBe(true);
  });

  it("rejects NaN, infinities and anything that isn't a number", () => {
    for (const value of [NaN, Infinity, -Infinity, "1", null, undefined, {}]) {
      expect(isNumber(value)).toBe(false);
    }
  });
});
