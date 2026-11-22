// The agent smoke check runs the deep health check on the candidate tag only
// (`--agent-only`), never on the live URL after traffic moves: flooding the
// live `/health?deep=1` must not 429 the live check and roll the deploy back.
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(__dirname, "agent-smoke-check.sh");
const run = promisify(execFile);

let server: Server | undefined;

afterEach(async () => {
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = undefined;
});

/** A stub agent that answers 200 to everything and records each request's path and query. */
async function stubAgent() {
  const requested: string[] = [];
  server = createServer((req, res) => {
    requested.push(req.url ?? "");
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requested };
}

/** Runs the smoke check; most checks fail against the stub, which is fine here. */
async function smokeCheck(args: string[]) {
  await run("bash", [script, ...args], { env: { ...process.env, SMOKE_RETRY_DELAY: "0" } }).catch(
    () => undefined,
  );
}

describe("agent smoke check", () => {
  it("calls the deep health check on the candidate (--agent-only)", async () => {
    const agent = await stubAgent();
    await smokeCheck(["--agent-only", agent.url, agent.url]);
    expect(agent.requested).toContain("/health?deep=1");
  });

  it("doesn't call the deep health check on the live URL", async () => {
    const agent = await stubAgent();
    await smokeCheck([agent.url, agent.url]);
    expect(agent.requested).toContain("/health");
    expect(agent.requested.filter((path) => path.includes("deep"))).toEqual([]);
  });
});
