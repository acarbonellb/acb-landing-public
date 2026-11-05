// The production check for the `/mcp` rate limit (scripts/mcp-rate-limit-check.sh),
// run against a local agent with the memory store, as the owner would run it
// against the live service. A small front end stands in for Cloud Run's: it
// appends the address it saw to `X-Forwarded-For`, so forged values stay to
// the left of it.
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createGuardrails } from "./compose";
import { loadConfig } from "./config";
import { listen, type RunningServer } from "./server";
import { testAppDeps } from "./test-deps";

const script = fileURLToPath(new URL("../../scripts/mcp-rate-limit-check.sh", import.meta.url));
const limit = 3;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function startAgent() {
  const config = loadConfig({ RATE_LIMIT_MCP_PER_MINUTE: String(limit) });
  const agent: RunningServer = await listen(
    createApp(testAppDeps(createGuardrails(null, config))),
    0,
    "127.0.0.1",
  );
  closers.push(agent.close);
  return agent.url;
}

/** A front end like Cloud Run's: forwards to `target`, appending the caller's address. */
async function startFrontEnd(target: string) {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && name !== "host") headers.set(name, value);
    }
    const seen = req.socket.remoteAddress ?? "";
    const forwarded = req.headers["x-forwarded-for"];
    headers.set("x-forwarded-for", forwarded ? `${forwarded}, ${seen}` : seen);
    const upstream = await fetch(new URL(req.url ?? "/", target), {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    upstream.headers.forEach((value, name) => res.setHeader(name, value));
    res.writeHead(upstream.status);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("front end has no port");
  return `http://127.0.0.1:${address.port}`;
}

async function runCheck(site: string, agent: string) {
  try {
    const { stdout } = await promisify(execFile)("bash", [script, site, agent, String(limit)]);
    return { code: 0, stdout };
  } catch (error) {
    const { code, stdout } = error as { code: number; stdout: string };
    return { code, stdout };
  }
}

const anyIp = /\b\d{1,3}(\.\d{1,3}){3}\b|\b[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}\b/i;

describe("the /mcp rate-limit check", () => {
  it("passes when the limit holds: refused through the site, then directly, then with forged headers", async () => {
    const url = await startFrontEnd(await startAgent());

    const { code, stdout } = await runCheck(url, url);

    expect(stdout).toMatch(/^ok +through the site: 3 allowed, 1 refused \(200×3 429×1\)$/m);
    expect(stdout).toMatch(/^ok +direct to the agent: 0 allowed, 1 refused \(429×1\)$/m);
    expect(stdout).toMatch(/^ok +forged X-Forwarded-For: 0 allowed, 10 refused \(429×10\)$/m);
    expect(code).toBe(0);
  });

  it("fails the forged phase when forged X-Forwarded-For values get a fresh limit", async () => {
    // No front end: the agent takes the forged value as the caller's address.
    const url = await startAgent();

    const { code, stdout } = await runCheck(url, url);

    expect(stdout).toMatch(/^ok +through the site: 3 allowed, 1 refused/m);
    expect(stdout).toMatch(/^FAIL +forged X-Forwarded-For: 10 allowed, 0 refused \(200×10\)$/m);
    expect(code).toBe(1);
  });

  it("prints no IP address or URL", async () => {
    const url = await startFrontEnd(await startAgent());

    const { stdout } = await runCheck(url, url);

    expect(stdout).not.toMatch(anyIp);
    expect(stdout).not.toContain("http");
  });
});
