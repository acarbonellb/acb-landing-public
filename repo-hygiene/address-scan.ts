// Keeps email addresses out of the public repo and the static export (#51).
// Test-only: the tree check (`src/repo-tree.test.ts`) and the export check
// (`e2e/contact.spec.ts`) use it; the site never imports it.
//
// It holds no address and no hash of one. Two checks:
// - Without any secret: every address in the text must be on a reserved test
//   domain or a listed third party, so a real personal address fails.
// - With CONTACT_EMAIL set (your shell, never CI): the address's forms are
//   derived from it at test time and searched for.

const at = /%40|&#0*64;|&#x0*40;|&commat;|\\u0040|\\x40|\s*[[({]\s*at\s*[\])}]\s*/gi;
const dot = /\s*[[({]\s*dot\s*[\])}]\s*/gi;
const address = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

/** Email-shaped strings in `text`, lowercased, after undoing common encodings of "@". */
export function findAddresses(text: string): string[] {
  const decoded = text.replace(at, "@").replace(dot, ".");
  return [...decoded.matchAll(address)].map(([m]) => m.toLowerCase());
}

// Reserved for tests and documentation (RFC 2606, RFC 6761), and the third
// parties whose addresses the repo legitimately holds.
const safeDomain =
  /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$|\.iam\.gserviceaccount\.com$|^oikoi\.com$/;
// oikoi.com: VT323's author, in its font license and the font file (assets/).

/** Whether `email` may appear in the public repo. */
export function isPublicSafeAddress(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return safeDomain.test(domain);
}

/** `email`'s address masked for a failure message: never print it whole. */
export function maskAddress(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

export type AddressForm = { label: string; value: string };

const reverse = (s: string) => [...s].reverse().join("");

/** Base64 of `s` at each of the 3 byte alignments it can have inside a larger blob. */
function base64Cores(s: string): string[] {
  return [0, 1, 2].map((k) => {
    const encoded = btoa(" ".repeat(k) + s);
    const end = (k + s.length) % 3 === 0 ? encoded.length : encoded.length - 4;
    return encoded.slice(k ? 4 : 0, end);
  });
}

/**
 * The forms of `email` that must not appear anywhere, plain or scrambled.
 * Labels never spell the address, so a failing check doesn't print it.
 */
export function addressForms(email: string): AddressForm[] {
  const full = email.toLowerCase();
  const local = full.slice(0, full.lastIndexOf("@"));
  // A short local part ("info") would match ordinary words.
  const distinctive = local.length >= 6;
  const escapedAt = ["&#64;", "&#x40;", "&commat;", "\\u0040", "\\x40"];
  return [
    { label: "the address", value: full },
    ...(distinctive
      ? [
          { label: "its local part", value: local },
          { label: "its local part reversed", value: reverse(local) },
        ]
      : []),
    { label: "the address reversed", value: reverse(full) },
    ...base64Cores(full).map((value) => ({ label: "the address in base64", value })),
    ...base64Cores(reverse(full)).map((value) => ({
      label: "the address reversed in base64",
      value,
    })),
    { label: "the address URL-encoded", value: encodeURIComponent(full) },
    ...escapedAt.map((e) => ({
      label: "the address with an escaped @",
      value: full.replace("@", e),
    })),
  ];
}
