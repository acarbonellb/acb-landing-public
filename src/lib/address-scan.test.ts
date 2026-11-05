import { describe, expect, it } from "vitest";
import { addressForms, findAddresses, isPublicSafeAddress } from "./address-scan";

describe("findAddresses", () => {
  it("finds plain addresses and common encodings of the @", () => {
    const text = [
      "write to ada@example.com",
      "mailto:bob%40example.org",
      "carol&#64;mail.example.net",
      "dan&#x40;example.com",
      'eve\\u0040example.com"',
      "fay [at] example.com",
      "gus (at) example (dot) org",
    ].join("\n");

    expect(findAddresses(text)).toEqual([
      "ada@example.com",
      "bob@example.org",
      "carol@mail.example.net",
      "dan@example.com",
      "eve@example.com",
      "fay@example.com",
      "gus@example.org",
    ]);
  });

  it("finds nothing in text without an address", () => {
    expect(findAddresses("@scope/pkg, user@, @mention and a@b")).toEqual([]);
  });
});

describe("isPublicSafeAddress", () => {
  it("accepts reserved test domains (RFC 2606 / 6761) and the listed third parties", () => {
    for (const address of [
      "alberto@example.com",
      "a@b.example",
      "ada@example.test",
      "x@foo.invalid",
      "ci@my-project.iam.gserviceaccount.com",
    ]) {
      expect(isPublicSafeAddress(address)).toBe(true);
    }
  });

  it("rejects any other domain", () => {
    // Joined at run time: this file must pass the tree check itself.
    const others = [
      ["someone", "gmail.com"],
      ["a", "b.dev"],
      ["me", "example.co.uk"],
      ["x", "notexample.com"],
    ].map((parts) => parts.join("@"));
    for (const address of others) {
      expect(isPublicSafeAddress(address)).toBe(false);
    }
  });
});

describe("addressForms", () => {
  const forms = addressForms("ada.lovelace@example.com");
  const found = (text: string) =>
    forms.filter(({ value }) => text.toLowerCase().includes(value.toLowerCase())).map((f) => f.label);

  it("catches the address plain, scrambled or encoded", () => {
    expect(found("Ada.Lovelace@Example.com")).toContain("the address");
    expect(found("ada.lovelace")).toContain("its local part");
    expect(found([..."ada.lovelace@example.com"].reverse().join(""))).toContain(
      "the address reversed",
    );
    expect(found(btoa("xx ada.lovelace@example.com yy"))).toContain("the address in base64");
    expect(found(btoa("ada.lovelace@example.com"))).toContain("the address in base64");
    expect(found("ada.lovelace%40example.com")).toContain("the address URL-encoded");
    expect(found("ada.lovelace&#64;example.com")).toContain("the address with an escaped @");
  });

  it("names each form without spelling it, so a failure prints no address", () => {
    for (const { label } of forms) expect(label).not.toMatch(/ada|lovelace|example/);
  });

  it("matches nothing in unrelated text", () => {
    expect(found("Ada Lovelace wrote notes on the analytical engine.")).toEqual([]);
  });
});
