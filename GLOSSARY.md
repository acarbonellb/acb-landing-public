# acb-landing

Alberto's portfolio site and the portfolio agent that answers visitors' questions about him.

## Language

### Agent evals

**Eval case**:
One question to the agent (optionally after prior turns) with what a good answer must and must not contain. Its kind is off-topic, mixed, injection, on-topic or unknown.
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
The metrics of every live run, one entry per recording set, oldest first. Only live runs add to it.
_Avoid_: log, changelog, trend
