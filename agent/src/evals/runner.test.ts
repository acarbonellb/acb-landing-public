import { describe, expect, it } from "vitest";
import { profile } from "../../../src/content/profile";
import { systemPrompt } from "../chat";
import { createFakeModel } from "../fake-model";
import { historyEntry } from "./history";
import { StaleRecordingError } from "./recording";
import { evaluate, recordCase, replayCase, RecordingFailedError } from "./runner";
import type { EvalCase } from "./scoring";

const contact: EvalCase = {
  id: "on01",
  slug: "contact",
  kind: "on_topic",
  question: "How can I contact him?",
  tools: ["get_contact"],
  facts: [profile.links.email],
};

const capital: EvalCase = {
  id: "ot01",
  slug: "capital-after-greeting",
  kind: "off_topic",
  priorTurns: [
    { role: "user", content: "hola" },
    { role: "assistant", content: "¡Hola! ¿Qué quieres saber de Alberto?" },
  ],
  question: "Cuál es la capital de España?",
  forbidden: [/\bmadrid\b/i],
};

const meta = { provider: "fake", model: "scripted" };

async function recordBoth() {
  const model = createFakeModel([
    { toolCalls: [{ id: "c1", name: "get_contact", input: {} }] },
    { text: `Email him at ${profile.links.email}.` },
    { text: "Solo puedo responder sobre Alberto." },
  ]);
  const a = await recordCase(contact, model, meta);
  const b = await recordCase(capital, model, meta);
  return { a, b, model };
}

// One word of the shipped prompt changed.
const editedPrompt = systemPrompt.replace("concise", "brief");

describe("the eval runner", () => {
  it("records cases through the real chat loop and replays them to identical outcomes", async () => {
    const { a, b, model } = await recordBoth();

    expect(a.recording).toMatchObject({
      caseId: "on01",
      slug: "contact",
      provider: "fake",
      model: "scripted",
    });
    expect(a.recording.calls).toHaveLength(2);
    expect(b.recording.calls).toHaveLength(1);
    // The prior turns reach the model before the new question.
    expect(model.requests[2].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(a.result.outcome).toEqual({
      answer: `Email him at ${profile.links.email}.`,
      toolCalls: ["get_contact"],
      stopReason: "end_turn",
    });
    expect(a.result.score.pass).toBe(true);

    const replayedA = await replayCase(contact, a.recording);
    const replayedB = await replayCase(capital, b.recording);

    expect(replayedA).toEqual(a.result);
    expect(replayedB).toEqual(b.result);
  });

  it("makes every replay stale when one word of the system prompt changes", async () => {
    const { a, b } = await recordBoth();

    for (const [evalCase, recording] of [
      [contact, a.recording],
      [capital, b.recording],
    ] as const) {
      const error = await replayCase(evalCase, recording, { system: editedPrompt }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StaleRecordingError);
      expect((error as StaleRecordingError).reason).toBe("request_changed");
    }
  });

  it("never returns a recording for a run that failed", async () => {
    const down = createFakeModel([{ error: new Error("connection refused") }]);

    await expect(recordCase(capital, down, meta)).rejects.toBeInstanceOf(RecordingFailedError);
  });
});

describe("evaluate (what `pnpm agent:eval:replay --check` runs)", () => {
  async function setOf() {
    const { a, b } = await recordBoth();
    return { ...meta, recordings: [a.recording, b.recording] };
  }

  it("reports no problems for fresh, leak-free recordings", async () => {
    const { problems, sets } = await evaluate({ cases: [contact, capital], sets: [await setOf()] });

    expect(problems).toEqual([]);
    expect(sets[0].results.map((r) => r.evalCase.id)).toEqual(["on01", "ot01"]);
  });

  it("fails as stale when one word of the system prompt changes", async () => {
    const { problems } = await evaluate({
      cases: [contact, capital],
      sets: [await setOf()],
      system: editedPrompt,
    });

    expect(problems).toEqual([
      expect.stringMatching(/^fake \/ scripted on01-contact: Stale recording \(request_changed/),
      expect.stringMatching(/^fake \/ scripted ot01-capital-after-greeting: Stale recording/),
    ]);
  });

  it("fails when a case has no recording", async () => {
    const set = await setOf();
    const { problems } = await evaluate({
      cases: [contact, capital],
      sets: [{ ...set, recordings: set.recordings.slice(0, 1) }],
    });

    expect(problems).toEqual([
      expect.stringMatching(/^fake \/ scripted ot01-capital-after-greeting: Stale recording \(missing_recording/),
    ]);
  });

  it("fails when a recorded answer leaks", async () => {
    const leaky = createFakeModel([{ text: "Madrid. Pero solo hablo de Alberto." }]);
    const { recording } = await recordCase(capital, leaky, meta);

    const { problems } = await evaluate({
      cases: [capital],
      sets: [{ ...meta, recordings: [recording] }],
    });

    expect(problems).toEqual([
      "fake / scripted ot01-capital-after-greeting leaked: leaked /\\bmadrid\\b/i",
    ]);
  });

  it("fails when a gated on-topic case fails, and only reports an ungated one", async () => {
    const gated: EvalCase = { ...contact, id: "on02", slug: "contact-gated", gated: true };
    const noEmail = () => createFakeModel([{ text: "Find him on LinkedIn." }]);
    const recordings = [
      (await recordCase(contact, noEmail(), meta)).recording,
      (await recordCase(gated, noEmail(), meta)).recording,
    ];

    const { problems } = await evaluate({
      cases: [contact, gated],
      sets: [{ ...meta, recordings }],
    });

    expect(problems).toEqual([
      "fake / scripted on02-contact-gated failed a gated case: called no tool, expected get_contact; missing fact: " +
        profile.links.email,
    ]);
  });

  it("adds the history to the report and fails when its latest entry disagrees", async () => {
    const set = await setOf();
    const fresh = await evaluate({ cases: [contact, capital], sets: [set] });
    const entry = historyEntry(fresh.sets[0], { date: "2026-11-03", commit: "abc1234" });

    const matching = await evaluate({ cases: [contact, capital], sets: [set], history: [entry] });
    const outdated = await evaluate({
      cases: [contact, capital],
      sets: [set],
      history: [{ ...entry, metrics: { ...entry.metrics, meanLatencyMs: 1 } }],
    });

    expect(matching.problems).toEqual([]);
    expect(matching.report).toContain("## History");
    expect(matching.report.startsWith(fresh.report)).toBe(true);
    expect(outdated.problems).toEqual([
      expect.stringMatching(/^fake \/ scripted: latest history entry doesn't match the recordings \(meanLatencyMs\)/),
    ]);
  });
});
