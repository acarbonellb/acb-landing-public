# Agent evals: record locally, replay in CI

The chat's unit tests use a scripted fake model. They prove the loop, tools and caps work, but not that a real model follows the system prompt, and the system prompt is the only defence against off-topic answers. Running a real model in CI would cost money and be nondeterministic. So evals run against a real model only on the developer's machine (`pnpm agent:eval`, local LM Studio by default, free). That live run records every model call at the `ModelClient` seam: a SHA-256 of each request and the response events. CI replays those recordings through the real loop and tools (`pnpm agent:eval:replay --check`) and fails when a recording is stale, when any off-topic, mixed or injection case leaks, or when the committed report differs from the regenerated one.

## Considered options

- **Real model in CI.** Rejected: every push costs money and needs an API key in CI, and results flake run to run.
- **Hand-written scripted responses.** Rejected: they prove our code, not the model's behaviour. That's what the fake-model unit tests already cover.
- **Snapshotting outcomes without request hashes.** Rejected: after a prompt or tool change, CI would still pass using answers to a question nobody asks any more.
- **Re-recording automatically when stale.** Rejected: it would call a model from CI, and it would hide behaviour changes the PR diff should show.
- **Gating on model quality (tool accuracy, fact coverage).** Rejected: these vary with the model and would block unrelated changes. Only leaks are gated, because a leak in the shipped prompt's recorded behaviour is a real regression with nothing downstream to catch it. The other metrics are reported.

## Consequences

- Any change to the system prompt, a tool's description or schema, the content module (tool results) or the chat limits makes the recordings stale. A developer has to re-run `pnpm agent:eval` locally and commit the new recordings and `report.md` in the same PR.
- Everything in a model request must be deterministic: no dates, random ids or env-dependent values. Otherwise every recording is stale as soon as it's written.
- Recordings and `report.md` are compared byte for byte, so formatters must not touch them (`.prettierignore`, `.gitattributes`).
