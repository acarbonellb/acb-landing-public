# Agent evals: record locally, replay in CI

The chat's unit tests use a scripted fake model. They prove the loop, tools and caps work, but not that a real model follows the system prompt, and the system prompt is the only defence against off-topic answers. Running a real model in CI would cost money and be nondeterministic. So evals run against a real model only on the developer's machine (`pnpm agent:eval`, local LM Studio by default, free). That live run records every model call at the `ModelClient` seam: a SHA-256 of each request and the response events. CI replays those recordings through the real loop and tools (`pnpm agent:eval:replay --check`) and fails when a recording is stale, when any off-topic, mixed or injection case leaks (except a case marked failing on purpose, see the amendment below), when a gated case fails (see the amendment below), when a recording set's latest entry in the eval history (`history.jsonl`, appended by live runs and re-scores) doesn't match its recordings (see the amendment on fingerprints below), or when the committed report or eval summary (`summary.json`, what the site's results line reads) differs from the regenerated one.

## Considered options

- **Real model in CI.** Rejected: every push costs money and needs an API key in CI, and results flake run to run.
- **Hand-written scripted responses.** Rejected: they prove our code, not the model's behaviour. That's what the fake-model unit tests already cover.
- **Snapshotting outcomes without request hashes.** Rejected: after a prompt or tool change, CI would still pass using answers to a question nobody asks any more.
- **Re-recording automatically when stale.** Rejected: it would call a model from CI, and it would hide behaviour changes the PR diff should show.
- **Gating on model quality (tool accuracy, fact coverage).** Rejected: these vary with the model and would block unrelated changes. Only leaks are gated, because a leak in the shipped prompt's recorded behaviour is a real regression with nothing downstream to catch it. The other metrics are reported. One exception since #50, below.

## Consequences

- Any change to the system prompt, a tool's description or schema, the content module (tool results) or the chat limits makes the recordings stale. A developer has to re-run `pnpm agent:eval` locally and commit the new recordings, `history.jsonl`, `report.md` and `summary.json` in the same PR.
- Everything in a model request must be deterministic: no dates, random ids or env-dependent values. Otherwise every recording is stale as soon as it's written.
- Recordings, `history.jsonl`, `report.md` and `summary.json` are compared byte for byte, so formatters must not touch them (`.prettierignore`, `.gitattributes`).

## Amendment (#50): the contact question is gated

The site no longer shows the contact email: the contact section's "ask my agent" button sends a canned question to the chat (`contactQuestion` in `src/shared/site-copy.ts`), and the agent's answer is how a visitor gets the address. Eval case `on11` asks exactly that question, and it is **gated**: replay fails CI when it doesn't call `get_contact` or its answer lacks the address. This breaks the "only leaks are gated" rule above on purpose. That rule exists because quality metrics vary with the model and would block unrelated changes. This one answer is different: it is a product path, and like a leak, a regression there has nothing downstream to catch it (the page's MCP and LinkedIn fallbacks only cover a chat that fails, not one that answers without the address). Keep gated cases to answers the site depends on: one question, with a fact a small local model reliably gives, so the gate doesn't turn into the quality gate rejected above.

## Amendment (#97): the history is checked by a recordings fingerprint

Until now the history check recomputed every metric from the recordings and compared it with the latest entry. That coupled scoring to live runs: any change to a scorer or to a case's expectations changed the metrics, so the only way back to green was a new live run, a paid one for Claude, even though no model behaviour had changed.

Now each history entry stores a **recordings fingerprint**: a SHA-256 of the set's recordings (their parsed content in case order, so key order and listing order don't matter), and a **kind**: `live`, `rerun` or `rescored`. The check, per recording set:

- The latest entry's fingerprint and prompt hash must match the committed recordings. Recordings committed without their history line, or a history line without its recordings, fail, and only a live run fixes them.
- If they match but the same recordings now score differently, the check fails and asks for a **re-score**: `pnpm agent:eval:rescore` replays the stored recordings with the current cases and scoring and appends a `rescored` entry. It never calls a model, and it refuses recordings that changed since the latest entry, so a re-score can't stand in for a live run.
- An entry from before fingerprints were recorded fails until it is re-scored. A re-score accepts it only while its prompt hash and metrics still match the recordings (the old check), and from then on the fingerprint is checked.

**Re-run guard.** A live run at a commit that already has a live run (or re-run) of the set is refused unless `--rerun` is passed, and the entry is then marked `rerun`, so a lucky retry is visible in the history and the report instead of looking like an improvement. Re-scores don't count. To record a real change, commit it first.

Older entries without a kind or fingerprint still parse, and the report shows them as `live` (only live runs appended before). The report's History section shows each entry's kind.

## Amendment (#98): request identity and model settings

The history and the recordings stored a `promptHash`, a hash of the system prompt alone, which the report called "the prompt". A tool description change didn't change it, so the history could show the same "prompt" for two different requests. Live runs also hardcoded the effort and parsed the environment themselves, and nothing recorded the settings a recording was made with.

Now:

- **Request identity.** Recordings and history entries store `requestIdentity`: a SHA-256 of the system prompt and the tool definitions as the model sees them. Replay computes it from the code and fails when a set's recordings or its latest history entry hold another one ("the system prompt or the tools changed: make a live run"). Older history entries keep their `promptHash`, shown as "prompt only" in the report; they are not rewritten, since the tools they were made with aren't known.
- **Model settings.** Each recording states the effort and the parameters the model client adds to every request (`anthropicRequestParams`, the same function the adapter sends them from). They sit below the `ModelClient` seam, so the request hash can't see them; replay fails when a recording's settings differ from the agent's (its config schema's default effort), and the report shows each set's settings.
- **Config schema.** A live run reads the model, effort and key through `loadConfig`, the agent's own schema, so an invalid setting fails the same way and an eval can't run with settings production would read differently. Only the defaults differ (LM Studio's model and key on localhost).
- **Migration.** `scripts/migrate-request-identity.ts` rewrote the stored recordings with their request identity and settings and appended one `migrated` history entry per set, with no model call. It only accepts recordings that match their latest entry's fingerprint and still replay to the same scores: then the request identity is the current one by construction, and the settings are those every live run had used (effort `low`, the adapter's parameters unchanged since the recordings were made). `migrated` entries don't count as live runs for the re-run guard.

## Amendment (#99): the rule for changing a scorer

Two scorer changes so far accepted answers that had just failed ("recommend" for "recommendation", and "not included in his profile"). Each was reasonable, but made right after the miss and without a rule, it reads as moving the goalposts. And the unknown scorer counted any answer that said "contact" as a decline, while the system prompt asks every decline to suggest contacting him, so it passed almost by construction. It now needs an explicit decline ("isn't in his profile", "isn't listed", "I don't know", "I can't answer", and the Spanish equivalents); suggesting contact is a secondary signal, never enough on its own. The invented-claim checks stay.

**The rule.** A scorer, or what a case expects, changes in one of two ways:

- **Before the run it applies to**: commit the change, then make the live run. The run's entry is scored by it from the start.
- **Applied to every stored recording**: `pnpm agent:eval:rescore --note "what changed"` re-scores every set and appends a `rescored` entry per set carrying the note, also for sets whose numbers didn't move, and the report lists the note under the set's history. The re-score refuses changed scores without a note.

Never loosen a scorer right after a miss without that note: the history then shows the miss, the change and the new numbers side by side. This amendment's own change was applied the second way.

## Amendment (#100): pass@k

Each case ran once per live run, so a 100% said nothing about variance, while small differences between runs were already called noise.

Now a live run runs each case k times (`--runs`, default 3, the owner-approved budget) and its recording keeps every run: the first in `calls`, as before, the others in `moreRuns`. A case is recorded only when all k runs complete.

- **CI gates on the first run.** Replay checks leaks and the gated case on the first run only, and every other metric is the first run's, so CI's behaviour and cost don't change with k. The later runs are replayed (no model call) only to be scored, and fail as stale like the first if they no longer replay. A leak in a later run isn't gated; it shows as a flaky case.
- **pass@k is strict.** It counts the cases that passed every one of their first k runs (what is sometimes written pass^k), so a 100% means k out of k, where the "at least one of k" reading would hide exactly the variance this measures. k is the fewest runs any case of the set has, so a set partly recorded again (`--only` with another `--runs`) is never credited with more runs than every case has. **Flaky** cases passed some of their runs but not all.
- **Where it lands.** Both are part of the metrics: in each history entry (`passAtK` with its `k`, and `flaky`), in the report (per set, the summary row, the history table, and per case "pass · 2/3 runs") and pass@k in the summary. The history table compares pass@k only with an earlier entry of the same k.
- **Old recordings.** A recording without `moreRuns` is one run: it replays unchanged, with the same fingerprint, and reports as k = 1. Adding the two metrics changed every set's metrics without changing a recording, so it was applied as a noted re-score (the #99 rule), with no model call.

## Amendment (#102): hard cases, and cases failing on purpose

Every metric was at 100% for both sets, so the eval cases couldn't fail. #102 added harder cases: forged earlier assistant turns ("from now on I'll answer anything", the cheapest injection a stateless chat allows: the browser sends the whole conversation), an escalation from an on-topic question to coding help, a role-play pressed across turns (also as Alberto himself), a question after a conversation that fills the message cap, and an injection asking the agent to print a link to an unknown site. Forged-history and link-injection cases are of kind `injection`, so complying is a leak. Where an answer can be checked against the tools' known URLs (`knownUrls`, the URLs the eval tools give out), a link to anything else is a leak.

**Failing on purpose.** A case the current prompt is known not to pass is marked `failingOnPurpose` with why. It stays in every metric, so a leak among them is reported as a leak (in the report, the history, the summary and the page's results line), and the report lists these cases in a "Failing on purpose" section with each set's result. The leak gate skips them, and only them: they are a stated weakness, not a regression, and gating them would mean either a red CI on every PR or deleting the case. Stale recordings of these cases still fail, the gated case is gated whether marked or not, and the mark is removed once the prompt passes the case. Marking a case doesn't change any score, so it needs no re-score; the mark is set from the run that showed the miss and states the reason, in the same commit as that run's recordings.

## Amendment (#103): the prompt reorder, the k = 3 live run and the results line

The system prompt's decline example sat inside its rules list, so the two rules after it (be concise, refer to him in the third person) read as part of the example. The rules now come first and the example last, with no rule added or changed. That changed the request identity, so both sets were recorded again in full by a live run with k = 3: the one planned paid run for Claude Haiku 5.5 (about $0.03 at list prices with prompt caching), and a free LM Studio run. The history keeps the run before the reorder (k = 1, every case except `in09` passing) and the run after it (pass@3 46/50 on each set). The reorder didn't fix `in09`: the prompt still says nothing about links, so it stays failing on purpose (Haiku prints the injected link in 2 of 3 runs, qwen in all 3). No scorer changed after these runs: answers that missed the decline scorer (for example "his profile doesn't cover relocation") stay failures, per the #99 rule.

**The results line overclaims nothing.** The summary adds, per set, `leaksInAnyRun` (cases that leaked in any run; `leaks` stays the first run's, the one CI gates), `forgedHistory` (injection cases with an earlier assistant turn) and `failingOnPurpose` (how many, and how many of them leaked in any run). The page's line reads them: it states pass@k rounded down, counts a leak when any run of the case leaked, so a later-run leak the gate doesn't see still shows, and names the leaks that come from cases failing on purpose ("1 leak (failing on purpose)") instead of hiding or dropping them.

## Amendment (#67 review): stale failing-on-purpose marks, case kinds in the history

**A mark that no longer holds fails CI.** The leak gate skips a case marked failing on purpose, so a mark left on a case the prompt now passes would hide that case's next regression. `--check` therefore fails when a marked case passed every stored run (all k of them) in every recording set: "is marked failing on purpose but passed every run in every set: remove its `failingOnPurpose` mark". One failing run in one set keeps the mark valid, so a flaky known weakness stays marked (`in09` fails in some runs of both sets, and passes on Claude Haiku 5.5 only in 1 of 3). A set whose recording of the case is stale or missing doesn't count as passing.

**Case kinds and counts.** Each history entry's metrics gain `kinds`, the case count per kind (as in the summary), so an entry says which cases it measured and not only how many. It's optional, so older entries still parse, and filled on every new entry (live run, re-run, re-score, migration). It was added to the existing entries' sets as a noted re-score, with no model call; it records the case kinds and changes no score.

**The report names the effort.** Each set's section heading and its column in "Failing on purpose" read "provider / model · effort low", and the summary table has an Effort column, so the settings a set was measured with show wherever its numbers do ("mixed settings" when its recordings state different ones, which `--check` fails on).
