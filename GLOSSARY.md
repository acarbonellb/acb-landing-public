# acb-landing

Alberto's portfolio site and the portfolio agent that answers visitors' questions about him.

## Language

### Portfolio Agent

**Portfolio Agent**:
The agent on this site that answers visitors' questions about Alberto from the site's content, in the chat and over MCP. It is also one of the agent projects the site lists.
_Avoid_: chatbot, assistant, bot

**Turn**:
One question from a visitor and the agent's answer to it. The answer may take several model calls; it is still one turn.
_Avoid_: exchange, round, message; never a single model call

**Chat request**:
What the chat sends the agent to answer one turn: the new question with the conversation before it.
_Avoid_: chat call, query, turn

**Answer signature**:
The agent's HMAC of an answer and its place (the conversation, its position there and the question it answered), sent with the answer's `done` event and sent back with the answer in later chat requests, so the agent only reads earlier answers it gave itself, where it gave them.
_Avoid_: turn signature, token, hash

**Model call**:
One request to the model while answering a turn: it either answers or asks for tools, whose results go into the next model call.
_Avoid_: turn, iteration, step, completion

**Tool**:
One read-only question the agent can answer from the site's content (projects, experience, stack, contact...), the same for the model and for MCP clients.
_Avoid_: function, endpoint, skill, action

**Spend cap**:
The monthly budget of estimated model spend. Once it is reached the chat stops until the next month; the tools over MCP keep working, as they cost nothing.
_Avoid_: quota, billing limit, budget

**Daily quota**:
The estimated model spend one rate-limit key may use on the chat in a UTC day. A key over it is refused like a rate limit until midnight UTC; other keys go on.
_Avoid_: daily limit, daily cap, allowance

**Reservation**:
The worst-case cost of one chat request, held against the daily quota and the spend cap while it runs so concurrent requests can't overshoot them, and settled to the actual cost when it ends, in one write per limit. One never settled (its instance died) is charged at its worst case once it expires.
_Avoid_: lock, booking, pre-authorization

**Outcome**:
How one chat request ended, as the usage stats count it: answered, cut off by a limit, refused, aborted by the visitor, failed, or turned away before starting.
_Avoid_: status, result

**Global ceiling**:
The most requests one endpoint takes a minute from every rate-limit key together, so rotating keys can't multiply what one source gets.
_Avoid_: global limit, total cap

**Durable state**:
The guardrail state that must survive a restart and be shared by every instance: the spend cap, the daily quota and the usage stats. Rate-limit windows and global ceilings are not durable: each instance keeps its own, and the agent runs one.
_Avoid_: persistent state, shared state

**Rate-limit key**:
Who a rate limit counts requests for: the visitor's IP address, or its /64 prefix for IPv6.
_Avoid_: client id, user, session

**Alert event**:
A log line, named by its `event` field, that tells the owner money or errors moved (a spend threshold, the spend cap or the provider limit reached, a high error rate, the store down). It fires once per crossing, not once per request.
_Avoid_: alert (that is the Cloud Monitoring policy that matches it), notification, alarm

**Request ID**:
The id each request to the agent gets, on every log line written while serving it and in its `X-Request-Id` header, so a chat request's stream and its store writes can be tied together.
_Avoid_: trace id, correlation id, session id

### Agent evals

**Eval case**:
One question to the agent (optionally after earlier turns) with what a good answer must and must not contain. Its kind is off-topic, mixed, injection, on-topic or unknown.
_Avoid_: test, scenario, prompt

**Live run**:
Running the eval cases against a real model on the developer's machine, which makes new recordings.
_Avoid_: eval run, benchmark

**Recording**:
Every model call one eval case made during a live run, in each of its runs: a hash of each request and the response events it got back.
_Avoid_: fixture, snapshot, cassette

**Run** (of an eval case):
One go at an eval case during a live run. A live run makes k runs of every case, and its recording keeps them all; CI replays and gates on the first.
_Avoid_: attempt, sample, trial

**pass@k**:
The share of a recording set's cases that passed every one of k runs, so 100% means k out of k. Recordings made before pass@k have one run (k = 1).
_Avoid_: pass rate, success rate

**Flaky case**:
An eval case that passed some of its runs but not all.
_Avoid_: unstable, intermittent

**Recording set**:
The recordings of all eval cases for one provider and model.
_Avoid_: suite, run

**Replay**:
Running the eval cases with the recorded responses in place of the model, so no model is called.
_Avoid_: mock run, dry run

**Stale**:
A recording whose requests no longer match what the agent now sends (prompt, tools, content or limits changed), or that is missing. Only a new live run fixes it.
_Avoid_: outdated, invalid

**Leak**:
Any part of the answer to an off-topic, mixed or injection question that the agent should have declined.
_Avoid_: jailbreak, failure

**Eval history**:
The metrics of every live run, re-run, re-score and migration (stored recordings rewritten to a new format by a script, same scores, no model call), one entry per recording set, oldest first. Each entry has its kind (`live`, `rerun`, `rescored` or `migrated`), the recordings fingerprint it was made from and the case count per kind.
_Avoid_: log, changelog, trend

**Eval summary**:
The machine-readable eval results (`summary.json`), one entry per recording set: cases, case kinds, leaks, cost per case and pass@k. Regenerated with the report from the replayed recordings; the results line reads it.
_Avoid_: scorecard, stats

**Recordings fingerprint**:
A hash of a recording set's recordings, stored in each history entry. CI checks the latest entry by it, not by recomputing metrics, so scoring changes don't force a live run.
_Avoid_: checksum, version

**Request identity**:
A hash of what every agent request shares: the system prompt and the tool definitions. Stored in each recording and history entry, so a prompt or tool change shows. Older history entries hold a hash of the system prompt alone.
_Avoid_: prompt hash, prompt version

**Model settings**:
What a recording states it was made with beyond the request: the effort and the parameters the model client adds to every request. CI flags recordings whose settings differ from the agent's.
_Avoid_: config, options

**Re-run**:
A second live run of a recording set at a commit that already has one. Refused unless asked for with `--rerun`, then marked as such in the history.
_Avoid_: retry, re-record

**Re-score**:
Scoring a set's stored recordings again with the current cases and scoring, and adding a history entry marked as such, with a note on the scoring change. No model is called.
_Avoid_: re-run, re-evaluate

**Decline**:
What an unknown case must answer: an explicit statement that it isn't in his profile, the agent doesn't know, or it can't answer, stating no number, currency amount or date that isn't in the content module (or the conversation). Suggesting to contact him is not a decline on its own, and a decline doesn't excuse an invented figure.
_Avoid_: refusal (that's the model's stop reason), deflection

**Failing on purpose**:
An eval case marked as one the current system prompt is known not to pass, with why. It counts in every metric, but the leak gate skips it; CI fails once it passes every stored run in every recording set, so the mark gets removed. The page alone calls their leaks "known leaks kept visible as failing cases until they are fixed" (ADR 0001, #142); everywhere else it stays "failing on purpose".
_Avoid_: known failure, skipped case, xfail

**Gated case**:
An eval case CI fails on when it fails, like a leak. Only the contact question is gated, because the site depends on its answer.
_Avoid_: required case, blocking test

### Site

**Agent project**:
An agent Alberto has built or is building, shown as a card on the page and served by the projects tool.
_Avoid_: project (alone), card, agent (alone)

**Practice**:
One way Alberto builds and runs agents (evals, human in the loop, cost and limits...), backed by a public source where one exists.
_Avoid_: principle, best practice, rule

**Results line**:
The Portfolio Agent card's result: the deployed model's eval metrics, taken from the eval summary when the site is built. It is shown on the page only, never served to the model.
_Avoid_: eval badge, score

**Usage line**:
The one-line summary of the agent's recent usage under the chat (questions answered, latency, errors, cost), read from the agent when the page loads.
_Avoid_: stats bar, metrics, dashboard

**Site analytics**:
What PostHog measures on the page: visits, where they come from, scroll depth and clicks, for visitors it never identifies. On only in a build with a PostHog project key. Not the agent's usage stats, which stay the exact figures for the agent, nor the usage line.
_Avoid_: tracking, telemetry, stats, metrics

**Cookie notice**:
The one-line prompt at the bottom left that tells visitors, in a build with site analytics, that the site uses a cookie for analytics. Its `[ok]` only hides it, for good in that browser; it changes nothing about what is collected.
_Avoid_: cookie banner, consent prompt, popup

**Contact fallback**:
How the page answers the contact question when the chat can't: with the address from the contact tool over MCP, or else a LinkedIn link.
_Avoid_: backup, retry, contact form

**Contact question**:
The canned message "ask my agent" sends to the chat from the contact section, asking for Alberto's email. The page shows no address itself: the agent answers it, then the MCP tools, then a LinkedIn link.
_Avoid_: contact form, show email

### Design System

**Design System**:
The artifact on claude.ai that shows the site's tokens, fonts, icon and real components with live cards. It is a derived copy: every file under its `project/` folder is generated from one commit on `main`, and it changes only by a sync.
_Avoid_: style guide, component library, design canvas (a canvas is per-task scratch space built from it)

**Sync**:
Bringing the Design System up to one commit of `main`: the sync command builds the whole `project/` folder from that commit in a temporary worktree and writes the sync manifest, then the agent publishes the manifest and lists the artifact's files to confirm it.
_Avoid_: deploy, update, refresh

**Sync manifest**:
The list of every file one sync publishes, with its published path, local file, content type and sha256, plus the publish call itself. It is stored under the git common directory as `design-system-sync/<commit>.json`, so every worktree of the clone finds it.
_Avoid_: publish list, file list

**Synced marker**:
The git tag `ds-synced` on GitHub, at the last commit whose sync verified. Only the verification hook moves it, after the artifact's file listing matched the sync manifest; it is force-moved and adds no commit. A sync is pending when a sources file changed between it and `origin/main`.
_Avoid_: last sync, sync commit, synced branch
