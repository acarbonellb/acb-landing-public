// The site's Content Security Policy (#93), added to the Hosting config after
// `next build` by scripts/hosting-config.ts. Build-time only: the site never
// imports this. It runs under plain Node (type stripping), so it imports
// nothing but Node built-ins.
//
// A static export can't use nonces (no request at render time), so every
// inline script the built pages hold is allowed by its hash: the theme script
// in layout.tsx and the RSC payload scripts Next writes, whose bodies change
// with every build. `connect-src` is the site itself (RSC payloads) and the
// agent's origin (chat, MCP, stats: ADR 0002).
import { createHash } from "node:crypto";

type Header = { key: string; value: string };
type HeaderRule = { source: string; headers: Header[] };
type HostingConfig = {
  hosting: { public: string; ignore: string[]; headers: HeaderRule[] } & Record<string, unknown>;
};

/** The `**` rule: headers every page gets. */
const ALL = "**";

/** The bodies of the inline (no `src`) scripts in `html`, as the browser hashes them. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(([, body]) => body)
    .filter((body) => body.length > 0);
}

const hash = (body: string) =>
  `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;

export function contentSecurityPolicy({
  pages,
  agentUrl,
}: {
  /** The built HTML of every page. */
  pages: string[];
  /** NEXT_PUBLIC_AGENT_URL as the build saw it; none means no agent. */
  agentUrl: string | undefined;
}): string {
  const scripts = [...new Set(pages.flatMap(inlineScripts).map(hash))];
  const agent = agentUrl ? [new URL(agentUrl).origin] : [];
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scripts].join(" "),
    // React and Next write a few `style` attributes into the HTML (e.g. the
    // typewriter's hidden lines); styles can't run code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    ["connect-src 'self'", ...agent].join(" "),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The Hosting config to deploy with the export: the committed one, serving
 * the directory it's written to (out/), with the CSP added to the headers
 * every page gets.
 */
export function hostingConfig<C extends HostingConfig>(
  committed: C,
  build: Parameters<typeof contentSecurityPolicy>[0],
): C {
  const csp: Header = { key: "Content-Security-Policy", value: contentSecurityPolicy(build) };
  const headers = committed.hosting.headers.some((rule) => rule.source === ALL)
    ? committed.hosting.headers.map((rule) =>
        rule.source === ALL ? { ...rule, headers: [...rule.headers, csp] } : rule,
      )
    : [{ source: ALL, headers: [csp] }, ...committed.hosting.headers];
  return { ...committed, hosting: { ...committed.hosting, public: ".", headers } };
}
