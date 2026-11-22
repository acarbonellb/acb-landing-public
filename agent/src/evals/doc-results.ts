// The "Current results" paragraph of docs/evals.md, generated from the
// replayed recordings like the report, so no number in it is typed by hand
// and `--check` fails when it drifts. Pure.
import { byString, setLabel } from "./format";
import { isFlaky, runScores, setMetrics, type CaseResult, type SetResult } from "./metrics";
import { leakKinds } from "./scoring";

const start = "<!-- results:start -->";
const end = "<!-- results:end -->";

const ids = (results: CaseResult[]) =>
  results
    .map((r) => `\`${r.evalCase.id}\`${r.evalCase.failingOnPurpose ? " (failing on purpose)" : ""}`)
    .join(", ");

function setParagraph(set: SetResult): string {
  const { cases, leaks, passAtK } = setMetrics(set);
  const leakCases = set.results.filter((r) => leakKinds.includes(r.evalCase.kind));
  const leakedAnyRun = leakCases
    .filter((r) => runScores(r).some((s) => s.leaked))
    .sort((a, b) => byString(a.evalCase.id, b.evalCase.id));
  const flaky = set.results.filter(isFlaky).sort((a, b) => byString(a.evalCase.id, b.evalCase.id));
  const leakText = leakedAnyRun.length
    ? `${leaks.n} of ${leaks.of} off-topic, mixed and injection cases ${leaks.n === 1 ? "leaks on its" : "leak on their"} first run, ${leakedAnyRun.length} in some run: ${ids(leakedAnyRun)}.`
    : "No case leaks in any run.";
  const flakyText = flaky.length ? `Flaky: ${ids(flaky)}.` : "No case is flaky.";
  const passText = passAtK ? `, pass@${passAtK.k} ${passAtK.n}/${passAtK.of}` : "";
  return `On \`${set.model}\` (${set.provider}): ${cases} cases${passText}. ${leakText} ${flakyText}`;
}

/** One paragraph per set, in set label order. */
export function resultsParagraph(sets: SetResult[]): string {
  return [...sets]
    .sort((a, b) => byString(setLabel(a), setLabel(b)))
    .map(setParagraph)
    .join("\n\n");
}

/** `doc` with `paragraph` between its results markers. */
export function withResults(doc: string, paragraph: string): string {
  const from = doc.indexOf(start);
  const to = doc.indexOf(end);
  if (from === -1 || to < from) throw new Error(`docs/evals.md has no ${start} … ${end} block`);
  return `${doc.slice(0, from + start.length)}\n${paragraph}\n${doc.slice(to)}`;
}
