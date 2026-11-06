# Chat contract

`POST /chat` on the [agent service](agent.md). The wire types and request limits live in [`src/shared/chat-contract.ts`](../src/shared/chat-contract.ts), imported by both the site and the agent: it is the source for the message, event and error-body shapes, and this page doesn't repeat them. The site's client is `src/lib/chat-client.ts`.

## The loop behind it

The model client is an injected interface (`agent/src/model.ts`): production uses Claude (`agent/src/anthropic.ts`), tests use a scripted fake (`agent/src/fake-model.ts`), and other providers can be added behind the same interface. The loop (`agent/src/chat.ts`) keeps the agent on topic and grounded in the tools through its system prompt, caps output tokens per model call and per request (one budget shared by all the request's calls) and model calls per request, and returns invalid tool input to the model as an error result.

## Request

`POST /chat` with `Content-Type: application/json`, a `ChatRequest`. The conversation is stateless: the browser sends what it shows, ending with the new question, and each earlier answer with the `signature` its `done` event carried (see [Signed answers](#signed-answers)).

```json
{ "messages": [
  { "role": "user", "content": "Who is Alberto?" },
  { "role": "assistant", "content": "A senior software engineer...", "signature": "Zm9v..." },
  { "role": "user", "content": "Is he remote?" }
] }
```

Roles alternate, start and end with `user`; at most `chatRequestLimits.maxMessages` messages of 1 to `chatRequestLimits.maxMessageChars` characters; no other fields (`signature` only on `assistant` messages); body at most 64 KB.

## Errors before streaming

JSON, an `HttpErrorBody` (what each code adds is documented on the type):

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Not JSON or fails validation (`message` says why), or an earlier answer is unsigned, doesn't match its signature or is out of its place (`message` says so and to reload the page) |
| 413 | `invalid_request` | Body too large |
| 429 | `rate_limited` | Too many requests from this IP, or its daily spend quota is used up. `Retry-After` is exposed to the browser via CORS |
| 503 | `unavailable` | No model configured, or the monthly spend cap is reached (then `message` says so) |

## Stream

Otherwise `200` with `Content-Type: text/event-stream`. Each SSE frame has `event: <type>` and `data: <JSON>`, a `ChatEvent` whose JSON also carries `type`. Use `fetch` and read the body (an `EventSource` can't `POST`). Events, in order of appearance:

| `type` | Meaning |
| --- | --- |
| `text` | A piece of the answer; append it |
| `tool_call` | The agent calls a tool, e.g. `get_projects({"status":"in-progress"})` |
| `tool_result` | That tool's result (`output` is the tool's JSON, or `{error}`) |
| `usage` | Tokens spent by one model call |
| `done` | Last event of a chat request that answered: the request's total usage, and the answer's signature, to send back with it |
| `error` | Last event of a chat request that failed; `message` is safe to show |

Every stream ends with exactly one `done` or `error`. `stopReason` (`ChatStopReason`) is `max_tokens` both when the per-call cap cut the answer and when the request's token budget ran out, and with `refusal` a polite `text` was sent. Stream `error` codes are `unavailable` (Claude overloaded, rate-limited upstream, unreachable, or the provider's spend or billing limit reached: retry later) and `internal`.

## Signed answers

The agent keeps no conversation, so a chat request could otherwise carry answers the agent never gave, e.g. a made-up one telling it to ignore its instructions. So it signs every answer it gives ([ADR 0004](adr/0004-signed-answers.md)): the `done` event's `signature` is `<conversation>.<position>.<mac>`, where `mac` is an HMAC-SHA256 (base64url), keyed by `ANSWER_SIGNING_KEY`, over the answer's text (the `text` deltas joined) as it goes back in the conversation (`answerForHistory` in `src/shared/chat-contract.ts`) together with its place: the conversation's id (22 random base64url characters, made with its first answer), the answer's position in it (1, 2, ...) and the question it answered.

The site keeps it with the answer and sends both back; an answer that ended in an `error` event has no signature and isn't sent. The agent checks every earlier answer before the request counts against the daily quota or spend cap, and refuses the request with `400 invalid_request`, without calling the model, if one is unsigned or doesn't match, follows a question it didn't answer, comes from another conversation, or isn't after the answers before it (positions must grow; gaps are fine, as the site leaves out turns it can't send back and, past the message cap, the oldest ones). The new answer is signed in the same conversation, one position after the last earlier answer.

The server keeps nothing: the id and position travel in the signature. Only the HTTP layer signs and checks (`agent/src/answer-signing.ts`); the model never sees a signature, and the eval runner, which calls the chat agent directly, is unaffected. Tests sign with a fixed key (`agent/src/test-deps.ts`).

**Deploys.** The agent ships first, then the site (the pipeline's order). From the agent's deploy, a tab opened before it fails its next follow-up question once with that 400, whose message says to reload the page; a new question in a fresh page works. Changing the key (a new version of the `answer-signing-key` secret, picked up on the next deploy) does the same to every open conversation. Creating the key is a one-time step in [Deploy](deploy.md#the-answer-signing-key).
