import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The project's billing budget, set up against a fake `gcloud` on PATH: it
// records every call and answers lookups from the state each test gives it,
// so no test touches GCP. Prior art: monitoring-alerts.test.ts.
const script = resolve(__dirname, "billing-budget.sh");
const deployDoc = readFileSync(resolve(__dirname, "../docs/deploy.md"), "utf8");
const project = "demo-project";
const projectNumber = "123456789012";
const account = "0A1B2C-3D4E5F-6A7B8C";

// What `gcloud billing budgets describe` prints with the script's --format:
// units, currency, nanos, period, credits, default IAM recipients disabled, thresholds.
type Budget = {
  units: string;
  currency: string;
  nanos?: string;
  period: string;
  credits: string;
  disableDefaultRecipients?: string;
  thresholds: string[];
};

/** The budget made by hand in the real project, before the script existed. */
const handMade: Budget = {
  units: "5",
  currency: "EUR",
  period: "MONTH",
  credits: "INCLUDE_ALL_CREDITS",
  thresholds: ["CURRENT_SPEND:0.5", "CURRENT_SPEND:0.9", "CURRENT_SPEND:1.0", "FORECASTED_SPEND:1.0"],
};

const fakeGcloud = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/calls"
case "$*" in
  "billing projects describe "*) [[ -s "$FAKE_DIR/account" ]] && echo "billingAccounts/$(cat "$FAKE_DIR/account")" ;;
  "projects describe "*) echo "$FAKE_NUMBER" ;;
  "billing budgets list "*) cut -f1 "$FAKE_DIR/budgets" ;;
  "billing budgets describe "*)
    for arg in "$@"; do id="\${arg##*/}"; grep -qF "$id	" "$FAKE_DIR/budgets" && grep -F "$id	" "$FAKE_DIR/budgets" | cut -f2- && break; done ;;
  "billing budgets create "*) echo "billingAccounts/$(cat "$FAKE_DIR/account")/budgets/new-budget" ;;
esac
exit 0
`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fake gcloud for a project on `account` whose budget lookup finds `budgets`. */
function fakeProject({ budgets = [] as Budget[], billing = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "billing-budget-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/gcloud"), fakeGcloud);
  chmodSync(join(dir, "bin/gcloud"), 0o755);
  writeFileSync(join(dir, "account"), billing ? account : "");
  const row = (b: Budget, i: number) =>
    [
      `billingAccounts/${account}/budgets/budget-${i}`,
      b.units,
      b.currency,
      b.nanos ?? "",
      b.period,
      b.credits,
      b.disableDefaultRecipients ?? "",
      b.thresholds.join(" "),
    ].join("\t") + "\n";
  writeFileSync(join(dir, "budgets"), budgets.map(row).join(""));
  writeFileSync(join(dir, "calls"), "");

  const run = (...args: string[]) => {
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, FAKE_DIR: dir, FAKE_NUMBER: projectNumber },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const calls = () => readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
  const changes = () => calls().filter((c) => /^billing budgets (create|update|delete) /.test(c));
  return { run, calls, changes };
}

describe("billing-budget.sh --dry-run", () => {
  it("adopts the hand-made budget: finds it, says it already matches, changes nothing", () => {
    const gcp = fakeProject({ budgets: [handMade] });
    const { status, output } = gcp.run("--dry-run", project);
    expect(status).toBe(0);
    expect(gcp.changes()).toEqual([]);
    expect(output).toContain("Dry run");
    expect(output).toContain("budgets/budget-0");
    expect(output).toContain("nothing to change");
    expect(output).not.toContain(account);
  });

  it("prints each field that differs and the update it would run, without running it", () => {
    const gcp = fakeProject({ budgets: [{ ...handMade, units: "20", thresholds: ["CURRENT_SPEND:0.5"] }] });
    const { status, output } = gcp.run("--dry-run", project);
    expect(status).toBe(0);
    expect(gcp.changes()).toEqual([]);
    expect(output).toContain("amount: 20 EUR -> 5 EUR");
    expect(output).toContain("thresholds: CURRENT_SPEND:0.5 -> CURRENT_SPEND:0.5 CURRENT_SPEND:0.9 CURRENT_SPEND:1.0 FORECASTED_SPEND:1.0");
    expect(output).toContain("gcloud billing budgets update budget-0 '--billing-account=<billing account>'");
    expect(output).toContain("--add-threshold-rule=percent=0.9,basis=current-spend");
    expect(output).not.toContain(account);
  });

  it("says it would create one when the project has no budget, without creating it", () => {
    const gcp = fakeProject();
    const { status, output } = gcp.run("--dry-run", project);
    expect(status).toBe(0);
    expect(gcp.changes()).toEqual([]);
    expect(output).toContain("no budget covers this project");
    expect(output).toContain("gcloud billing budgets create '--billing-account=<billing account>'");
    expect(output).not.toContain(account);
  });
});

describe("billing-budget.sh", () => {
  it("leaves a matching budget alone: re-running it is a no-op", () => {
    const gcp = fakeProject({ budgets: [handMade] });
    for (let i = 0; i < 2; i++) {
      const { status, output } = gcp.run(project);
      expect(status).toBe(0);
      expect(output).toContain("nothing to change");
      expect(output).not.toContain(account);
    }
    expect(gcp.changes()).toEqual([]);
  });

  it("reconciles a budget that drifted in place instead of creating a second one", () => {
    const gcp = fakeProject({ budgets: [{ ...handMade, units: "20", period: "QUARTER", credits: "EXCLUDE_ALL_CREDITS" }] });
    const { status, output } = gcp.run(project);
    expect(status).toBe(0);
    const [update, ...rest] = gcp.changes();
    expect(rest).toEqual([]);
    expect(update).toMatch(new RegExp(`^billing budgets update budget-0 --billing-account=${account} `));
    expect(update).toContain("--budget-amount=5EUR");
    expect(update).toContain("--calendar-period=month");
    expect(update).toContain("--credit-types-treatment=include-all-credits");
    expect(update).toContain(
      "--clear-threshold-rules --add-threshold-rule=percent=0.5,basis=current-spend --add-threshold-rule=percent=0.9,basis=current-spend " +
        "--add-threshold-rule=percent=1.0,basis=current-spend --add-threshold-rule=percent=1.0,basis=forecasted-spend",
    );
    expect(output).not.toContain(account);
  });

  it("creates the budget for this project only when none covers it", () => {
    const gcp = fakeProject();
    expect(gcp.run(project).status).toBe(0);
    const [create, ...rest] = gcp.changes();
    expect(rest).toEqual([]);
    expect(create).toMatch(new RegExp(`^billing budgets create --billing-account=${account} `));
    expect(create).toContain(`--filter-projects=projects/${projectNumber}`);
    expect(create).toContain("--budget-amount=5EUR");
    expect(create).toContain("--threshold-rule=percent=1.0,basis=forecasted-spend");
  });

  it("looks the budget up by this project's number on the project's own billing account", () => {
    const gcp = fakeProject({ budgets: [handMade] });
    gcp.run("--dry-run", project);
    const list = gcp.calls().find((c) => c.startsWith("billing budgets list "));
    expect(list).toContain(`--billing-account=${account}`);
    expect(list).toContain(`budgetFilter.projects:"projects/${projectNumber}"`);
  });

  it("stops without changing anything when two budgets cover the project", () => {
    const gcp = fakeProject({ budgets: [handMade, handMade] });
    const { status, output } = gcp.run(project);
    expect(status).toBe(1);
    expect(output).toContain("more than one budget");
    expect(gcp.changes()).toEqual([]);
  });

  it("stops without changing anything when the budget's default email recipients are off", () => {
    const gcp = fakeProject({ budgets: [{ ...handMade, disableDefaultRecipients: "True" }] });
    const { status, output } = gcp.run(project);
    expect(status).toBe(1);
    expect(output).toContain("default recipients");
    expect(gcp.changes()).toEqual([]);
  });

  it("stops when billing is not enabled on the project", () => {
    const gcp = fakeProject({ billing: false });
    const { status, output } = gcp.run(project);
    expect(status).toBe(1);
    expect(output).toContain("no billing account");
    expect(gcp.changes()).toEqual([]);
  });

  it("refuses a missing or malformed project id without calling gcloud", () => {
    const gcp = fakeProject();
    expect(gcp.run().status).toBe(2);
    expect(gcp.run("--dry-run", "Not A Project").status).toBe(2);
    expect(gcp.calls()).toEqual([]);
  });
});

describe("the deploy doc", () => {
  it("describes the budget the script sets: its amount, thresholds and who is emailed", () => {
    const section = deployDoc.slice(deployDoc.indexOf("#### Billing budget"));
    expect(section).toContain("scripts/billing-budget.sh");
    expect(section).toContain("5 EUR");
    for (const t of ["50%", "90%", "100%", "forecast"]) expect(section).toContain(t);
    expect(section).toContain("Billing Account Administrator");
    expect(section).not.toMatch(/[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}/);
  });
});
