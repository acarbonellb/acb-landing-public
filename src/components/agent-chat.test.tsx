import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AgentChat } from "./agent-chat";

const CHAT_URL = "http://agent.test/chat";
const MCP_URL = "http://agent.test/mcp";

function sse(...events: object[]): string {
  return events
    .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

// A streaming response the test pushes frames into, so it can look at the UI
// mid-answer.
function controlledStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }),
    push: (...events: object[]) => controller.enqueue(encoder.encode(sse(...events))),
    close: () => controller.close(),
  };
}

function answer(...events: object[]): Response {
  return new Response(sse(...events), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

// Fake fetch that serves the queued responses in order and records requests.
function fakeFetch(...responses: Response[]) {
  const requests: { url: string; body: unknown }[] = [];
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

function renderChat(fetch: typeof globalThis.fetch) {
  return render(<AgentChat chatUrl={CHAT_URL} mcpUrl={MCP_URL} fetch={fetch} />);
}

function input() {
  return screen.getByRole("textbox", { name: /ask the agent/i });
}

function log() {
  return screen.getByRole("log", { name: /conversation/i });
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(input(), text);
  await user.keyboard("{Enter}");
}

describe("AgentChat", () => {
  it("shows the visitor's question, the tool calls and the streamed answer", async () => {
    const user = userEvent.setup();
    const stream = controlledStream();
    const { fetch, requests } = fakeFetch(stream.response);
    renderChat(fetch);

    await ask(user, "What have you built?");

    expect(within(log()).getByText("What have you built?")).toBeInTheDocument();
    expect(input()).toHaveValue("");
    expect(requests[0]).toEqual({
      url: CHAT_URL,
      body: { messages: [{ role: "user", content: "What have you built?" }] },
    });
    expect(await screen.findByText(/thinking/i)).toBeInTheDocument();
    expect(log()).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();

    stream.push(
      { type: "tool_call", id: "t1", name: "get_projects", input: {} },
      { type: "tool_call", id: "t2", name: "get_experience", input: { company: "Acme" } },
      { type: "text", delta: "Three " },
    );
    expect(await within(log()).findByText("get_projects()")).toBeInTheDocument();
    expect(
      within(log()).getByText('get_experience({"company":"Acme"})'),
    ).toBeInTheDocument();
    expect(await within(log()).findByText("Three")).toBeInTheDocument();

    stream.push({ type: "text", delta: "agents." }, { type: "done", stopReason: "end_turn", usage: {} });
    stream.close();

    expect(await within(log()).findByText("Three agents.")).toBeInTheDocument();
    expect(log()).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it("sends the earlier exchange along with a follow-up question", async () => {
    const user = userEvent.setup();
    const { fetch, requests } = fakeFetch(
      answer({ type: "text", delta: "Alberto." }, { type: "done", stopReason: "end_turn", usage: {} }),
      answer({ type: "text", delta: "Yes." }, { type: "done", stopReason: "end_turn", usage: {} }),
    );
    renderChat(fetch);

    await ask(user, "Who?");
    await within(log()).findByText("Alberto.");
    await ask(user, "Remote?");
    await within(log()).findByText("Yes.");

    expect(requests[1].body).toEqual({
      messages: [
        { role: "user", content: "Who?" },
        { role: "assistant", content: "Alberto." },
        { role: "user", content: "Remote?" },
      ],
    });
  });

  it("does not send an empty question", async () => {
    const user = userEvent.setup();
    const { fetch, requests } = fakeFetch();
    renderChat(fetch);

    await user.type(input(), "   ");
    await user.keyboard("{Enter}");

    expect(requests).toHaveLength(0);
  });

  it("shows a rate-limit notice with the retry time", async () => {
    const user = userEvent.setup();
    const { fetch } = fakeFetch(
      Response.json(
        { error: { code: "rate_limited", message: "Too many questions." } },
        { status: 429, headers: { "Retry-After": "42" } },
      ),
    );
    renderChat(fetch);

    await ask(user, "Hi");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/rate limit/i);
    expect(alert).toHaveTextContent("Too many questions.");
    expect(alert).toHaveTextContent(/try again in 42s/i);
    expect(input()).toBeEnabled();
  });

  it("shows an unavailable notice with the agent's message", async () => {
    const user = userEvent.setup();
    const { fetch } = fakeFetch(
      Response.json(
        { error: { code: "unavailable", message: "Monthly budget reached." } },
        { status: 503 },
      ),
    );
    renderChat(fetch);

    await ask(user, "Hi");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/unavailable/i);
    expect(alert).toHaveTextContent("Monthly budget reached.");
  });

  it("shows an error notice when the stream fails, and keeps the partial answer", async () => {
    const user = userEvent.setup();
    const { fetch, requests } = fakeFetch(
      answer({ type: "text", delta: "Half an" }, { type: "error", code: "internal", message: "Something broke." }),
      answer({ type: "text", delta: "Fine." }, { type: "done", stopReason: "end_turn", usage: {} }),
    );
    renderChat(fetch);

    await ask(user, "Q1");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(alert).toHaveTextContent("Something broke.");
    expect(within(log()).getByText("Half an")).toBeInTheDocument();

    // The failed exchange is not sent as history, and the notice clears.
    await ask(user, "Q2");
    await within(log()).findByText("Fine.");
    expect(requests[1].body).toEqual({
      messages: [{ role: "user", content: "Q2" }],
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the public MCP endpoint and a command to copy", async () => {
    const user = userEvent.setup();
    renderChat(fakeFetch().fetch);

    expect(screen.getByText(MCP_URL)).toBeInTheDocument();
    const command = `claude mcp add --transport http albertocarbonell ${MCP_URL}`;
    expect(screen.getByText(command)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /copy/i }));

    expect(await navigator.clipboard.readText()).toBe(command);
    expect(screen.getByRole("button", { name: /copied/i })).toBeInTheDocument();
  });
});
