import { describe, expect, it } from "vitest";
import committed from "../../firebase.json";
import { hostingConfig } from "./security-headers";

// sha256 of the script bodies, computed independently with
// `printf '%s' '<body>' | openssl dgst -sha256 -binary | base64`.
const ALERT = "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='";
const NEXT_INIT = "'sha256-VXfQxoId3eHgS78yBQY2mYYWuOAzZGdxULBMV816UdU='";

const page = [
  "<html><head>",
  '<script src="/_next/static/chunks/a.js" async=""></script>',
  "<script>alert(1)</script>",
  "</head><body>",
  '<script id="_R_">self.__next_f.push([0])</script>',
  "</body></html>",
].join("");

/** The headers the generated config sends with every page. */
function pageHeaders(config: ReturnType<typeof hostingConfig>) {
  const rule = config.hosting.headers.find((h) => h.source === "**");
  return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

function directives(csp: string) {
  return Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe("hostingConfig", () => {
  it("allows exactly the built pages' inline scripts, by hash", () => {
    const config = hostingConfig(committed, { pages: [page], agentUrl: undefined, posthogKey: undefined });

    const csp = directives(pageHeaders(config)["Content-Security-Policy"]);
    expect(csp["script-src"]).toEqual(["'self'", ALERT, NEXT_INIT]);
  });

  it("lists a script shared by several pages once", () => {
    const config = hostingConfig(committed, { pages: [page, page], agentUrl: undefined, posthogKey: undefined });

    const csp = directives(pageHeaders(config)["Content-Security-Policy"]);
    expect(csp["script-src"]).toEqual(["'self'", ALERT, NEXT_INIT]);
  });

  it("lets the page connect to itself and to the agent's origin only", () => {
    const withAgent = hostingConfig(committed, {
      pages: [page],
      agentUrl: "https://agent.example.dev/",
      posthogKey: undefined,
    });
    const noAgent = hostingConfig(committed, { pages: [page], agentUrl: undefined, posthogKey: undefined });

    expect(directives(pageHeaders(withAgent)["Content-Security-Policy"])["connect-src"]).toEqual([
      "'self'",
      "https://agent.example.dev",
    ]);
    expect(directives(pageHeaders(noAgent)["Content-Security-Policy"])["connect-src"]).toEqual([
      "'self'",
    ]);
  });

  it("lets a build with a PostHog key connect to PostHog's EU ingestion and assets hosts, and nothing else changes", () => {
    const build = { pages: [page], agentUrl: "https://agent.example.dev/" };
    const withKey = directives(
      pageHeaders(hostingConfig(committed, { ...build, posthogKey: "phc_test" }))["Content-Security-Policy"],
    );
    const noKey = directives(pageHeaders(hostingConfig(committed, { ...build, posthogKey: undefined }))["Content-Security-Policy"]);

    expect(withKey["connect-src"]).toEqual([
      "'self'",
      "https://agent.example.dev",
      "https://eu.i.posthog.com",
      "https://eu-assets.i.posthog.com",
    ]);
    expect({ ...withKey, "connect-src": undefined }).toEqual({ ...noKey, "connect-src": undefined });
    expect(withKey["script-src"]).toEqual(["'self'", ALERT, NEXT_INIT]);
  });

  it("gives a build without a PostHog key today's policy, byte for byte", () => {
    const build = { pages: [page], agentUrl: "https://agent.example.dev/" };
    const csp = (posthogKey: string | undefined) =>
      pageHeaders(hostingConfig(committed, { ...build, posthogKey }))["Content-Security-Policy"];

    expect(csp(undefined)).toBe(
      [
        "default-src 'self'",
        `script-src 'self' ${ALERT} ${NEXT_INIT}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self'",
        "font-src 'self'",
        "connect-src 'self' https://agent.example.dev",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    expect(csp("")).toBe(csp(undefined));
  });

  it("forbids framing, plugins and other origins, and keeps the hardening headers", () => {
    const headers = pageHeaders(hostingConfig(committed, { pages: [page], agentUrl: undefined, posthogKey: undefined }));

    const csp = directives(headers["Content-Security-Policy"]);
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("serves the export it sits in and keeps the committed rewrites and headers", () => {
    const config = hostingConfig(committed, { pages: [page], agentUrl: undefined, posthogKey: undefined });

    // Written to out/firebase.json, next to the files it publishes.
    expect(config.hosting.public).toBe(".");
    expect(config.hosting.ignore).toContain("firebase.json");
    expect(config.hosting.rewrites).toEqual(committed.hosting.rewrites);
    for (const rule of committed.hosting.headers) {
      if (rule.source !== "**") expect(config.hosting.headers).toContainEqual(rule);
    }
  });
});
