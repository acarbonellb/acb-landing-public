import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The Cloud Monitoring setup for the agent's alert events (#91), run against a
// fake `gcloud` on PATH: it records every call and answers lookups from the
// state each test gives it, so no test touches GCP.
const script = resolve(__dirname, "monitoring-alerts.sh");
const alertDocs = readFileSync(resolve(__dirname, "../docs/logs-and-alerts.md"), "utf8");
const email = "owner@example.com";
const project = "demo-project";

const fakeGcloud = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/calls"
for arg in "$@"; do
  case "$arg" in
    --policy-from-file=*|--channel-content-from-file=*)
      n=$(ls "$FAKE_DIR/files" | wc -l)
      cp "\${arg#*=}" "$FAKE_DIR/files/$n.json" ;;
  esac
done
filter_value() { for arg in "$@"; do case "$arg" in --filter=*) v="\${arg#*\\"}"; echo "\${v%\\"}" ;; esac; done; }
case "$*" in
  "beta monitoring channels list "*)
    grep -F "	$(filter_value "$@")" "$FAKE_DIR/channels" 2>/dev/null | cut -f1 ;;
  "monitoring policies list "*)
    grep -F "	$(filter_value "$@")" "$FAKE_DIR/policies" 2>/dev/null | cut -f1 ;;
  "beta monitoring channels create "*) echo "projects/$FAKE_PROJECT/notificationChannels/new-channel" ;;
  "monitoring policies create "*) echo "projects/$FAKE_PROJECT/alertPolicies/new-policy" ;;
esac
exit 0
`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

type Existing = { channels?: Record<string, string>; policies?: Record<string, string> };

/** A fake gcloud whose lookups find `existing` (display name -> resource name). */
function fakeProject(existing: Existing = {}) {
  const dir = mkdtempSync(join(tmpdir(), "monitoring-alerts-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "files"));
  writeFileSync(join(dir, "bin/gcloud"), fakeGcloud);
  chmodSync(join(dir, "bin/gcloud"), 0o755);
  const table = (rows: Record<string, string> = {}) =>
    Object.entries(rows).map(([display, name]) => `${name}\t${display}\n`).join("");
  writeFileSync(join(dir, "channels"), table(existing.channels));
  writeFileSync(join(dir, "policies"), table(existing.policies));
  writeFileSync(join(dir, "calls"), "");

  const run = (...args: string[]) => {
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, FAKE_DIR: dir, FAKE_PROJECT: project },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const calls = () => readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
  /** Every channel or policy file gcloud was handed, parsed, in call order. */
  const files = () =>
    readdirSync(join(dir, "files"))
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map((f) => JSON.parse(readFileSync(join(dir, "files", f), "utf8")));
  const addChannel = (display: string, name: string) =>
    appendFileSync(join(dir, "channels"), `${name}\t${display}\n`);
  return { run, calls, files, addChannel };
}

describe("monitoring-alerts.sh setup --dry-run", () => {
  it("prints the gcloud commands without running gcloud or printing the email", () => {
    const gcp = fakeProject();
    const { status, output } = gcp.run("setup", "--dry-run", project, email);
    expect(status).toBe(0);
    expect(gcp.calls()).toEqual([]);
    expect(output).toContain(`gcloud services enable monitoring.googleapis.com --project ${project}`);
    expect(output).toContain(`gcloud beta monitoring channels create --project ${project}`);
    expect(output).toContain(`gcloud monitoring policies create --project ${project}`);
    expect(output).not.toContain(email);
    expect(output).not.toContain("owner@");
  });
});

/** The alert events the docs list as alerting (WARNING or ERROR rows), from the "Alert events" table of docs/logs-and-alerts.md. */
function documentedAlertEvents(): { event: string; severity: string }[] {
  const table = alertDocs.slice(alertDocs.indexOf("\n## Alert events\n")).split("\n\n")[2];
  return table
    .split("\n")
    .map((line) => line.match(/^\| `([a-z_]+)` \| `(WARNING|ERROR)` \|/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, event, severity]) => ({ event, severity }));
}

type Policy = {
  displayName: string;
  severity: string;
  notificationChannels: string[];
  conditions: { conditionMatchedLog: { filter: string } }[];
};

describe("monitoring-alerts.sh setup", () => {
  it("creates the email channel and one log-match policy per documented alert event", () => {
    const gcp = fakeProject();
    const { status, output } = gcp.run("setup", project, email);
    expect(status).toBe(0);

    const [channel, ...policies] = gcp.files() as [{ type: string; labels: Record<string, string> }, ...Policy[]];
    expect(channel).toMatchObject({ type: "email", labels: { email_address: email } });

    const events = documentedAlertEvents();
    expect(events.map((e) => e.event)).toEqual([
      "spend_threshold",
      "spend_cap_reached",
      "provider_limit",
      "chat_error_rate",
      "store_unavailable",
    ]);
    expect(policies).toHaveLength(events.length);
    for (const { event, severity } of events) {
      const policy = policies.find((p) => p.displayName === `Agent: ${event}`);
      expect(policy, event).toBeDefined();
      expect(policy!.severity).toBe(severity);
      expect(policy!.notificationChannels).toEqual([`projects/${project}/notificationChannels/new-channel`]);
      const { filter } = policy!.conditions[0].conditionMatchedLog;
      expect(filter).toContain('resource.labels.service_name="agent"');
      expect(filter).toContain(`jsonPayload.event="${event}"`);
    }
    expect(gcp.calls().filter((c) => c.startsWith("monitoring policies create "))).toHaveLength(events.length);
    expect(gcp.calls().join("\n")).not.toContain(email);
    expect(output).not.toContain(email);
  });

  it("updates what already exists instead of creating duplicates", () => {
    const existing = Object.fromEntries(
      documentedAlertEvents().map(({ event }) => [`Agent: ${event}`, `projects/${project}/alertPolicies/${event}`]),
    );
    const gcp = fakeProject({
      channels: { "Agent alerts (email)": `projects/${project}/notificationChannels/old-channel` },
      policies: existing,
    });
    expect(gcp.run("setup", project, email).status).toBe(0);

    const calls = gcp.calls();
    expect(calls.filter((c) => / create /.test(c))).toEqual([]);
    expect(calls).toContainEqual(
      expect.stringMatching(/^beta monitoring channels update projects\/demo-project\/notificationChannels\/old-channel /),
    );
    for (const name of Object.values(existing)) {
      expect(calls).toContainEqual(expect.stringContaining(`monitoring policies update ${name} `));
    }
    const policies = gcp.files().slice(1) as Policy[];
    expect(new Set(policies.flatMap((p) => p.notificationChannels))).toEqual(
      new Set([`projects/${project}/notificationChannels/old-channel`]),
    );
  });

  it("stops when two channels share the display name, without creating anything", () => {
    const gcp = fakeProject({
      channels: { "Agent alerts (email)": "projects/demo-project/notificationChannels/a" },
    });
    // A second row with the same display name.
    gcp.addChannel("Agent alerts (email)", "projects/demo-project/notificationChannels/b");
    const { status, output } = gcp.run("setup", project, email);
    expect(status).toBe(1);
    expect(output).toContain("more than one channel");
    expect(gcp.calls().filter((c) => / (create|update) /.test(c))).toEqual([]);
  });

  it("refuses a missing or malformed email without calling gcloud or echoing it", () => {
    const gcp = fakeProject();
    expect(gcp.run("setup", project).status).toBe(2);
    const { status, output } = gcp.run("setup", project, "owner.example.com");
    expect(status).toBe(2);
    expect(output).not.toContain("owner.example.com");
    expect(gcp.calls()).toEqual([]);
  });
});

describe("monitoring-alerts.sh test", () => {
  it("writes one entry its policy matches: the agent's service, the event, its severity", () => {
    const gcp = fakeProject();
    expect(gcp.run("test", project, "spend_threshold").status).toBe(0);
    const [call] = gcp.calls();
    expect(call).toMatch(/^logging write /);
    expect(call).toContain('"event": "spend_threshold"');
    expect(call).toContain('"test": true');
    expect(call).toContain("--severity=WARNING");
    expect(call).toContain("--monitored-resource-type=cloud_run_revision");
    expect(call).toContain("service_name=agent");
  });

  it("only prints the command with --dry-run, and refuses an event that has no policy", () => {
    const gcp = fakeProject();
    const dry = gcp.run("test", "--dry-run", project);
    expect(dry.status).toBe(0);
    expect(dry.output).toContain("gcloud logging write");
    expect(dry.output).toContain("store_unavailable");
    expect(gcp.run("test", project, "store_recovered").status).toBe(2);
    expect(gcp.calls()).toEqual([]);
  });
});
