import { describe, expect, it } from "vitest";
import { obfuscateEmail, revealEmail } from "./obfuscated-email";

// Expected value worked out by hand: "moc.elpmaxe@ada" through `base64`.

describe("obfuscated email", () => {
  it("scrambles the address so neither it nor an @ survives", () => {
    expect(obfuscateEmail("ada@example.com")).toBe("bW9jLmVscG1heGVAYWRh");
  });

  it("reveals the original address", () => {
    expect(revealEmail("bW9jLmVscG1heGVAYWRh")).toBe("ada@example.com");
  });
});
