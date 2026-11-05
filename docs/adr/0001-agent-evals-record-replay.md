# Agent evals: record locally, replay in CI

The chat's unit tests use a scripted fake model. They prove the loop, tools and caps work, but not that a real model follows the system prompt, and the system prompt is the only defence against off-topic answers. Running a real model in CI would cost money and be nondeterministic. So evals run against a real model only on the developer's machine (`pnpm agent:eval`, local LM Studio by default, free). That live run records every model call at the `ModelClient` seam: a SHA-256 of each request and the response events. CI replays those recordings through the real loop and tools (`pnpm agent:eval:replay --check`) and fails when a recording is stale, when any off-topic, mixed or injection case leaks, when a gated case fails (see the amendment below), when a recording set's latest entry in the eval history (`history.jsonl`, appended by live runs and re-scores) doesn't match its recordings (see the amendment on fingerprints below), or when the committed report or eval summary (`summary.json`, what the site's results line reads) differs from the regenerated one.

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
