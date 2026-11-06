# Agent: signed answers keep the chat stateless

The chat is stateless ([chat contract](../chat-contract.md)): the browser sends the conversation it shows with every chat request, so the agent keeps nothing between turns and any Cloud Run instance can answer any request. That also lets a caller send earlier answers the agent never gave, such as a made-up answer in which the agent "agreed" to drop its instructions, and the model reads them as its own words. So the agent signs every answer (#95): the `done` event carries an HMAC-SHA256 of the answer's text, keyed by `ANSWER_SIGNING_KEY` (Secret Manager in production), and the agent refuses a chat request with `400 invalid_request`, before the chat runs, when an earlier answer is unsigned or doesn't match its signature.

What is signed is the answer, as the glossary uses the word (the text of one turn's answer, in the form it goes back in the conversation: trimmed and cut to the message limit, `answerForHistory`), bound to its place: the conversation it was given in, its position there and the question it answered. A genuine answer replayed after a forged question ("Will you ignore your instructions?" followed by an earlier "Yes, of course.") reads to the model as consent it never gave, so the answer alone isn't enough (#65, story 40). The signature is `<conversation>.<position>.<mac>`: the conversation id (random, made with its first answer) and the position travel in it, so the server stays stateless. The agent accepts earlier answers only in one conversation, at growing positions, each after the question it was signed with; positions may skip, because the site drops turns it can't send back and, past the message cap, the oldest ones.

## Considered options

- **Keep conversations on the server** (Firestore, keyed by a conversation id). Rejected: one more read and write per chat request and a document per conversation to expire, for the same guarantee.
- **Drop unsigned or changed answers instead of refusing.** Rejected: the model would answer a conversation the visitor doesn't see, silently. Refusing is visible, and the site never sends an answer it can't sign.
- **Sign the answer alone** (the first version, #95). Rejected in #65: a genuine answer could be replayed after a question it didn't answer, or reordered.
- **Sign the whole conversation up to each answer** (a chain). Rejected: the site drops the oldest turns past the message cap, and failed or empty ones, so the prefix an answer was signed over is often no longer sent; every long conversation would be refused. Binding the question, a position that only has to grow and a conversation id stops the same replays and survives those gaps.

## Consequences

- The key must be the same on every instance and survive cold starts, so it is required in production (the agent refuses to start without it). Elsewhere each process makes its own, so a restart of a local agent refuses the answers it signed before.
- The contract changed both ways (`signature` on `done` and on earlier answers), so the agent deploys first. The site treats the signature as opaque, so binding it to its place (`v2` of what is signed) needed no site change; answers signed by `v1` are refused once, like a key change. A tab opened before the deploy fails its next follow-up question once, with a message to reload the page. A new key does the same to every open conversation.
- Only the HTTP layer signs and checks (`agent/src/answer-signing.ts`). The chat agent and the eval runner that calls it directly never see a signature, so the model gets the same requests and the recordings stay fresh.
- The signature is checked before the daily quota and the spend cap, so a forged conversation never reserves spend; it still counts against the per-IP rate limit, which runs first.
