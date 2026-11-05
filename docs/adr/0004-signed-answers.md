# Agent: signed answers keep the chat stateless

The chat is stateless (README, "Chat endpoint contract"): the browser sends the conversation it shows with every chat request, so the agent keeps nothing between turns and any Cloud Run instance can answer any request. That also lets a caller send earlier answers the agent never gave, such as a made-up answer in which the agent "agreed" to drop its instructions, and the model reads them as its own words. So the agent signs every answer (#95): the `done` event carries an HMAC-SHA256 of the answer's text, keyed by `ANSWER_SIGNING_KEY` (Secret Manager in production), and the agent refuses a chat request with `400 invalid_request`, before the chat runs, when an earlier answer is unsigned or doesn't match its signature.

What is signed is the answer, as the glossary uses the word: the text of one turn's answer, in the form it goes back in the conversation (trimmed and cut to the message limit, `answerForHistory`). Not the question, not its place in the conversation: the visitor writes the questions anyway, and a genuine answer moved elsewhere is still something the agent said.

## Considered options

- **Keep conversations on the server** (Firestore, keyed by a conversation id). Rejected: one more read and write per chat request and a document per conversation to expire, for the same guarantee.
- **Drop unsigned or changed answers instead of refusing.** Rejected: the model would answer a conversation the visitor doesn't see, silently. Refusing is visible, and the site never sends an answer it can't sign.
- **Sign the whole conversation up to each answer.** Rejected: the extra binding stops nothing the visitor can't do with their own questions, and an answer cut to the message limit would need the same canonical form anyway.

## Consequences

- The key must be the same on every instance and survive cold starts, so it is required in production (the agent refuses to start without it). Elsewhere each process makes its own, so a restart of a local agent refuses the answers it signed before.
- The contract changed both ways (`signature` on `done` and on earlier answers), so the agent deploys first. A tab opened before the deploy fails its next follow-up question once, with a message to reload the page. A new key does the same to every open conversation.
- Only the HTTP layer signs and checks (`agent/src/answer-signing.ts`). The chat agent and the eval runner that calls it directly never see a signature, so the model gets the same requests and the recordings stay fresh.
- The signature is checked before the daily quota and the spend cap, so a forged conversation never reserves spend; it still counts against the per-IP rate limit, which runs first.
