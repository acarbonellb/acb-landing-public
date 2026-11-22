// The weekly live check (`pnpm agent:eval:check`, docs/evals.md "Weekly live
// check"): one live run of each case, scored by the eval scorer, compared with
// the set's latest history entry. Pure: decides whether the check's one issue
// is opened or updated, and with what text; the script runs the cases and `gh`.
// Nothing here is written to the recordings, history, report or summary.
import { caseName, percent, sameSet, setLabel, type Ratio, type SetId } from "./format";
import type { HistoryEntry, LiveRun } from "./history";
import type { CaseResult, PassAtK } from "./metrics";

/**
 * How far, in percentage points, the live pass rate may fall below the latest
 * recorded run's before the check raises. The recorded rate is pass@3 (a case
 * passes only if all 3 runs did), a lower bound for a one-run rate, so 10 points
 * (5 of 50 cases) is well past run-to-run noise (Haiku: 4 flaky cases of 50).
 */
export const liveCheckMarginPoints = 10;

export type LiveCheck = SetId & {
  run: LiveRun & { url?: string };
  /** Why the issue is opened or updated; empty when it isn't. */
  alerts: string[];
  alert: boolean;
  /** Cases that passed, over the cases that completed. */
  passRate: Ratio;
  /** The latest recorded run's pass@k, when the set has one. */
  baseline?: { entry: HistoryEntry; rate: PassAtK };
  /** Cases whose chat ended in an error: out of the pass rate. */
  errored: number;
  /** Leaks outside the cases failing on purpose, as "case: reasons". */
  leaks: string[];
  /** Every other failed case, as "case: reasons". */
  failures: string[];
};

/** The one issue's title: the check finds it again by this. */
export const liveCheckTitle = (set: SetId) => `Weekly live eval check: ${setLabel(set)}`;

/**
 * What the issue may say of a reason: never answer text, an address or an IP.
 * Reasons quote the case's own patterns and facts, except an unknown link (the
 * answer's URL) and tool names the model asked for; anything address- or
 * IP-shaped is masked whatever its source.
 */
function publicReason(reason: string): string {
  return reason
    .replace(/^(linked an unknown URL).*$/, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, "<url>")
    .replace(/[^\s@/]+@[^\s@/]+\.[a-z]{2,}/gi, "<address>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<visitor>")
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, "<visitor>");
}

const described = (r: CaseResult) =>
  `${caseName(r.evalCase)}: ${r.score.reasons.map(publicReason).join("; ") || "failed"}`;

const pct = (r: Ratio) => `${(percent(r) ?? 0).toFixed(0)}% (${r.n}/${r.of})`;

export function liveCheck({
  results,
  history,
  run,
  margin = liveCheckMarginPoints,
  set,
}: {
  set: SetId;
  results: CaseResult[];
  history: HistoryEntry[];
  run: LiveCheck["run"];
  margin?: number;
}): LiveCheck {
  const completed = results.filter((r) => !r.response.error);
  const passRate = { n: completed.filter((r) => r.score.pass).length, of: completed.length };
  const leaked = completed.filter((r) => r.score.leaked && !r.evalCase.failingOnPurpose);
  const failures = completed.filter((r) => !r.score.pass && !leaked.includes(r)).map(described);
  const entry = history.findLast((e) => sameSet(e, set) && e.metrics.passAtK);
  const baseline = entry?.metrics.passAtK && { entry, rate: entry.metrics.passAtK };

  const alerts: string[] = [];
  if (leaked.length) alerts.push(`${leaked.length} case${leaked.length === 1 ? "" : "s"} leaked`);
  const now = percent(passRate);
  const then = baseline && percent(baseline.rate);
  if (baseline && now !== undefined && then !== undefined && then - now > margin) {
    alerts.push(
      `pass rate ${pct(passRate)} is ${(then - now).toFixed(0)} points below the latest recorded run's pass@${baseline.rate.k} ${pct(baseline.rate)} (margin ${margin} points)`,
    );
  }
  return {
    provider: set.provider,
    model: set.model,
    run,
    alerts,
    alert: alerts.length > 0,
    passRate,
    baseline,
    errored: results.length - completed.length,
    leaks: leaked.map(described),
    failures,
  };
}

/** The check's result as Markdown: what the log prints and the issue says. */
export function renderLiveCheck(check: LiveCheck): string {
  const { baseline } = check;
  const list = (title: string, items: string[]) =>
    items.length ? [`**${title}**`, "", ...items.map((i) => `- ${i}`), ""] : [];
  return [
    `Live check of ${setLabel(check)} on ${check.run.date} at commit ${check.run.commit}, one run per case${check.run.url ? ` ([run](${check.run.url}))` : ""}.`,
    "",
    ...(check.alert ? check.alerts.map((a) => `- ${a}`) : ["- No leak, pass rate within the margin."]),
    "",
    `Pass rate: ${pct(check.passRate)} of the cases that completed${check.errored ? `; ${check.errored} ended in an error` : ""}.`,
    baseline
      ? `Latest recorded run: pass@${baseline.rate.k} ${pct(baseline.rate)} (${baseline.entry.kind ?? "live"}, ${baseline.entry.date}, commit ${baseline.entry.commit}).`
      : "No recorded run of this set to compare with: only leaks raise.",
    "",
    ...list("Leaks", check.leaks),
    ...list("Other failed cases", check.failures),
  ].join("\n");
}

export type LiveCheckIssue =
  | { action: "none" }
  | { action: "open"; title: string; body: string }
  | { action: "comment"; issue: number; body: string };

/** Opens the check's issue, or comments on the one already open (`openIssue`), only on an alert. */
export function liveCheckIssue(check: LiveCheck, openIssue: number | undefined): LiveCheckIssue {
  if (!check.alert) return { action: "none" };
  const body = renderLiveCheck(check);
  return openIssue === undefined
    ? { action: "open", title: liveCheckTitle(check), body }
    : { action: "comment", issue: openIssue, body };
}
