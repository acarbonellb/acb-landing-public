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

**Model call**:
One request to the model while answering a turn: it either answers or asks for tools, whose results go into the next model call.
_Avoid_: turn, iteration, step, completion

**Tool**:
One read-only question the agent can answer from the site's content (projects, experience, stack, contact...), the same for the model and for MCP clients.
_Avoid_: function, endpoint, skill, action

**Spend cap**:
The monthly budget of estimated model spend. Once it is reached the chat stops until the next month; the tools over MCP keep working, as they cost nothing.
_Avoid_: quota, billing limit, budget

**Reservation**:
The worst-case cost of one chat request, held against the spend cap while it runs so concurrent requests can't overshoot it, and settled to the actual cost when it ends.
_Avoid_: lock, booking, pre-authorization

**Outcome**:
How one chat request ended, as the usage stats count it: answered, cut off by a limit, refused, aborted by the visitor, failed, or turned away before starting.
_Avoid_: status, result

**Rate-limit key**:
Who a rate limit counts requests for: the visitor's IP address.
_Avoid_: client id, user, session

### Agent evals

**Eval case**:
One question to the agent (optionally after earlier turns) with what a good answer must and must not contain. Its kind is off-topic, mixed, injection, on-topic or unknown.
_Avoid_: test, scenario, prompt

**Live run**:
Running the eval cases against a real model on the developer's machine, which makes new recordings.
_Avoid_: eval run, benchmark

**Recording**:
Every model call one eval case made during a live run: a hash of each request and the response events it got back.
_Avoid_: fixture, snapshot, cassette

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
The metrics of every live run, re-run and re-score, one entry per recording set, oldest first. Each entry has its kind and the recordings fingerprint it was made from.
_Avoid_: log, changelog, trend

**Recordings fingerprint**:
A hash of a recording set's recordings, stored in each history entry. CI checks the latest entry by it, not by recomputing metrics, so scoring changes don't force a live run.
_Avoid_: checksum, version

**Re-run**:
A second live run of a recording set at a commit that already has one. Refused unless asked for with `--rerun`, then marked as such in the history.
_Avoid_: retry, re-record

**Re-score**:
Scoring a set's stored recordings again with the current cases and scoring, and adding a history entry marked as such, with a note on the scoring change. No model is called.
_Avoid_: re-run, re-evaluate

**Decline**:
What an unknown case must answer: an explicit statement that it isn't in his profile, the agent doesn't know, or it can't answer. Suggesting to contact him is not a decline on its own.
_Avoid_: refusal (that's the model's stop reason), deflection

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
The Portfolio Agent card's result: the deployed model's latest eval metrics, taken from the eval history when the site is built. It is shown on the page only, never served to the model.
_Avoid_: eval badge, score

**Usage line**:
The one-line summary of the agent's recent usage under the chat (questions answered, latency, errors, cost), read from the agent when the page loads.
_Avoid_: stats bar, metrics, dashboard

**Contact fallback**:
How the page answers the contact question when the chat can't: with the address from the contact tool over MCP, or else a LinkedIn link.
_Avoid_: backup, retry, contact form

**Contact question**:
The canned message "ask my agent" sends to the chat from the contact section, asking for Alberto's email. The page shows no address itself: the agent answers it, then the MCP tools, then a LinkedIn link.
_Avoid_: contact form, show email
