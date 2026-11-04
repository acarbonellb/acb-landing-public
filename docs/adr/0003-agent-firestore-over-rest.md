# Agent: shared guardrail state in Firestore, over its REST API

The agent's rate limits and monthly spend cap kept their state in memory, so on Cloud Run (scale to zero, possibly several instances) a cold start reset the month's spend to $0 and each instance had its own budget (#21). They now live in Firestore in the same GCP project: no server to run, works with scale to zero, and the traffic fits the free tier. The agent reaches it through Firestore's REST API with plain `fetch`, behind a one-method `DocumentStore` (atomic read-modify-write by optimistic concurrency: commit with an `updateTime` precondition, retry on conflict), not through the `@google-cloud/firestore` SDK. The Docker image is just the esbuild bundle with no `node_modules`, and the SDK (gRPC, google-gax, protobuf files read from disk at runtime) doesn't bundle cleanly into it; two REST calls and a token from the metadata server are all the agent needs.

## Considered options

- **`@google-cloud/firestore` SDK.** Rejected: it would need `node_modules` in the image or bundler workarounds, for a few documents updated a few times a minute.
- **Redis (Memorystore or a hosted Redis).** Rejected: Memorystore is a fixed monthly cost and needs a VPC connector; a hosted Redis is one more account and secret.
- **Keep memory with `--max-instances=1`.** Rejected: a cold start still forgets the month's spend.

## Consequences

- The in-memory implementations stay for local development and tests; `AGENT_STORE` picks the store, `memory` by default.
- The Firestore adapter is tested against a fake of the REST API, not the real service; the emulator works too (`FIRESTORE_EMULATOR_HOST`).
- Spend holds expire (15 minutes), so an instance that dies mid-request can't hold budget for the rest of the month.
- The weekly usage stats (`usage/<YYYY-Www>`, #47) use the same store and the same read-modify-write, so `DocumentStore` stays one method: reading a document is an update that writes nothing. It adds one write per chat and per MCP request, all to the week's single document, which is fine at this traffic (well under Firestore's sustained write rate per document) but would need sharded counters if it grew a lot.
