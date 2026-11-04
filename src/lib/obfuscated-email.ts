// The contact address travels to the browser scrambled, so it never appears
// as plain text in the exported HTML or its RSC payload; ContactEmail
// unscrambles it on the client. This stops harvesting by crawlers that read
// HTML, not determined scrapers.

/** Reversed, then base64: no `@` or address text left to grep for. */
export function obfuscateEmail(email: string): string {
  return btoa([...email].reverse().join(""));
}

export function revealEmail(obfuscated: string): string {
  return [...atob(obfuscated)].reverse().join("");
}
