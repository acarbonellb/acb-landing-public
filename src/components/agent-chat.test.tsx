import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  chatError,
  chatStream,
  controlledChatStream,
  done,
  fakeFetch,
} from "@/testing/agent-fakes";
import { AgentChat } from "./agent-chat";

const CHAT_URL = "http://agent.test/chat";
const MCP_URL = "http://agent.test/mcp";

function renderChat(fetch: typeof globalThis.fetch) {
  return render(
    <AgentChat
      chatUrl={CHAT_URL}
      mcpUrl={MCP_URL}
      fetch={fetch}
    />,
  );
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
    const stream = controlledChatStream();
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

    stream.push({ type: "text", delta: "agents." }, done());
    stream.close();

    expect(await within(log()).findByText("Three agents.")).toBeInTheDocument();
    expect(log()).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument();
  });

  it("sends the earlier exchange, with its answer's signature, along with a follow-up question", async () => {
    const user = userEvent.setup();
    const { fetch, requests } = fakeFetch(
      chatStream({ type: "text", delta: "Alberto." }, done("end_turn", "sig-who")),
      chatStream({ type: "text", delta: "Yes." }, done()),
    );
    renderChat(fetch);

    await ask(user, "Who?");
    await within(log()).findByText("Alberto.");
    await ask(user, "Remote?");
    await within(log()).findByText("Yes.");

    expect(requests[1].body).toEqual({
      messages: [
        { role: "user", content: "Who?" },
        { role: "assistant", content: "Alberto.", signature: "sig-who" },
        { role: "user", content: "Remote?" },
      ],
    });
  });

  it("renders the agent's Markdown but keeps the visitor's message plain", async () => {
    const user = userEvent.setup();
    const { fetch } = fakeFetch(
      chatStream(
        { type: "tool_call", id: "t1", name: "get_projects", input: { status: "in-progress" } },
        { type: "text", delta: "He built **three** agents:\n\n- Fraud\n- Portfolio" },
        done(),
      ),
    );
    renderChat(fetch);

    await ask(user, "Is he **good**?");

    expect(await within(log()).findByRole("strong")).toHaveTextContent("three");
    expect(within(log()).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Fraud",
      "Portfolio",
    ]);
    expect(within(log()).getByText("Is he **good**?")).toBeInTheDocument();
    expect(
      within(log()).getByText('get_projects({"status":"in-progress"})'),
    ).toBeInTheDocument();
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
      chatError(
        { code: "rate_limited", message: "Too many questions." },
        { headers: { "Retry-After": "42" } },
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

  it("shows the daily quota like a rate limit, with when it resets instead of a countdown", async () => {
    const user = userEvent.setup();
    const { fetch } = fakeFetch(
      chatError(
        {
          code: "rate_limited",
          message: "You've asked the agent a lot today.",
          retryAfterSeconds: 7200,
          resetsAt: "2026-11-16T00:00:00.000Z",
        },
        { headers: { "Retry-After": "7200" } },
      ),
    );
    renderChat(fetch);

    await ask(user, "Hi");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/rate limit/i);
    expect(alert).toHaveTextContent("You've asked the agent a lot today.");
    expect(alert).toHaveTextContent("Try again from 00:00 UTC on November 16, 2026.");
    expect(alert).not.toHaveTextContent(/7200s/);
    expect(input()).toBeEnabled();
  });

  it("shows an unavailable notice with the agent's message, pointing to the MCP server", async () => {
    const user = userEvent.setup();
    const { fetch } = fakeFetch(
      chatError({ code: "unavailable", message: "Monthly budget reached." }),
    );
    renderChat(fetch);

    await ask(user, "Hi");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/unavailable/i);
    expect(alert).toHaveTextContent("Monthly budget reached.");
    // The MCP tools don't use the model, so they keep working.
    expect(alert).toHaveTextContent(/MCP server still works/i);
    expect(alert).toHaveTextContent(MCP_URL);
  });

  it("shows when the chat reopens once the monthly budget is used up", async () => {
    const user = userEvent.setup();
    const { fetch } = fakeFetch(
      chatError({
        code: "unavailable",
        message: "The agent has used up its budget for this month.",
        resetsAt: "2026-12-01T00:00:00.000Z",
      }),
    );
    renderChat(fetch);

    await ask(user, "Hi");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The agent has used up its budget for this month.");
    expect(alert).toHaveTextContent("It's back on December 1, 2026 (UTC).");
  });

  it("doesn't repeat the notice title when the agent's message starts with it", async () => {
    const user = userEvent.setup();
    const { fetch } = fakeFetch(
      chatError({
        code: "unavailable",
        message: "The agent is unavailable right now. Please try again in a minute.",
      }),
    );
    renderChat(fetch);

    await ask(user, "Hi");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.match(/The agent is unavailable right now\./g)).toHaveLength(1);
    expect(alert).toHaveTextContent("Please try again in a minute.");
  });

  it("shows an error notice when the stream fails, and keeps the partial answer", async () => {
    const user = userEvent.setup();
    const { fetch, requests } = fakeFetch(
      chatStream({ type: "text", delta: "Half an" }, { type: "error", code: "internal", message: "Something broke." }),
      chatStream({ type: "text", delta: "Fine." }, done()),
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
