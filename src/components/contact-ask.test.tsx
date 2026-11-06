import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { contactQuestion } from "@/shared/site-copy";
import {
  chatError,
  chatStream,
  contactAnswer,
  done,
  fakeFetch,
  json,
  mcpContact,
  toResponse,
} from "@/testing/agent-fakes";
import { AgentChat } from "./agent-chat";
import { ContactAsk } from "./contact-ask";

// "ask my agent" in the contact section sends a canned question to the chat
// in the agent section, so the page never shows the address. Both render
// here, as on the page.

const CHAT_URL = "http://agent.test/chat";
const MCP_URL = "https://site.test/mcp";
const MCP_DIRECT_URL = "http://agent.test/mcp";
const LINKEDIN = "https://www.linkedin.com/in/ada/";

const contactReply = () => contactAnswer("ada@example.com");
const mcpReply = () => mcpContact("ada@example.com");

// A response the test releases later, to look at the UI mid-answer.
function pending() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

function renderPage(fetch: typeof globalThis.fetch) {
  return render(
    <>
      <section id="agent">
        <AgentChat chatUrl={CHAT_URL} mcpUrl={MCP_URL} fetch={fetch} />
      </section>
      <section id="contact">
        <ContactAsk linkedin={LINKEDIN} mcpUrl={MCP_DIRECT_URL} fetch={fetch} />
      </section>
    </>,
  );
}

const log = () => screen.getByRole("log", { name: /conversation/i });
const input = () => screen.getByRole("textbox", { name: /ask the agent/i });
const askButton = () => screen.getByRole("button", { name: "ask my agent" });

describe("ask my agent", () => {
  it("sends the canned question to the chat, focuses it and links the answer's address", async () => {
    const user = userEvent.setup();
    const { fetch, requests } = fakeFetch(contactReply());
    renderPage(fetch);

    await user.click(askButton());

    expect(within(log()).getByText(contactQuestion)).toBeInTheDocument();
    expect(input()).toHaveFocus();
    const link = await within(log()).findByRole("link", { name: "ada@example.com" });
    expect(link).toHaveAttribute("href", "mailto:ada@example.com");
    expect(requests).toEqual([
      { url: CHAT_URL, body: { messages: [{ role: "user", content: contactQuestion }] } },
    ]);
  });

  it("appends the question to an open conversation", async () => {
    const user = userEvent.setup();
    const { fetch, requests } = fakeFetch(
      chatStream({ type: "text", delta: "Hi!" }, done("end_turn", "sig-hi")),
      contactReply(),
    );
    renderPage(fetch);
    await user.type(input(), "hello{Enter}");
    await within(log()).findByText("Hi!");

    await user.click(askButton());

    await within(log()).findByRole("link", { name: "ada@example.com" });
    expect(requests[1].body).toEqual({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hi!", signature: "sig-hi" },
        { role: "user", content: contactQuestion },
      ],
    });
  });

  it("is disabled while an answer is streaming", async () => {
    const user = userEvent.setup();
    const reply = pending();
    const { fetch } = fakeFetch(reply.promise);
    renderPage(fetch);

    await user.type(input(), "hello{Enter}");

    expect(askButton()).toBeDisabled();
    reply.resolve(toResponse(contactReply()));
    await within(log()).findByText(/ada@example.com/);
    // The address shows before the stream ends; the button comes back after.
    await waitFor(() => expect(askButton()).toBeEnabled());
  });

  it.each([
    [
      "the spend cap (503)",
      () => chatError({ code: "unavailable", message: "Resting.", resetsAt: "2026-12-01T00:00:00Z" }),
      /the model is unavailable; here's the answer straight from my tools/i,
    ],
    [
      "the rate limit (429)",
      () =>
        chatError(
          { code: "rate_limited", message: "Too many.", retryAfterSeconds: 30 },
          { headers: { "Retry-After": "30" } },
        ),
      /rate limit was reached; here's the answer straight from my tools/i,
    ],
    [
      "a stream that ends in an unavailable error",
      () => chatStream({ type: "error", code: "unavailable", message: "The agent is unavailable." }),
      /the model is unavailable; here's the answer straight from my tools/i,
    ],
  ])("answers from the MCP get_contact tool after %s", async (_, chat, notice) => {
    const user = userEvent.setup();
    const { fetch, requests } = fakeFetch(chat(), mcpReply());
    renderPage(fetch);

    await user.click(askButton());

    const link = await within(log()).findByRole("link", { name: "ada@example.com" });
    expect(link).toHaveAttribute("href", "mailto:ada@example.com");
    expect(within(log()).getByText(notice)).toBeInTheDocument();
    expect(requests[1]).toEqual({
      url: MCP_DIRECT_URL,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_contact", arguments: {} },
      },
    });
    // The fallback replaces the chat's own notice.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(askButton()).toBeEnabled());
  });

  it.each([
    ["is unreachable", new TypeError("offline")],
    // A JSON-RPC error, not the chat's error body.
    ["is rate limited too", json(429, { error: { code: -32000 } })],
  ])("links to LinkedIn when the MCP server %s as well", async (_, mcp) => {
    const user = userEvent.setup();
    const { fetch } = fakeFetch(new TypeError("offline"), mcp);
    renderPage(fetch);

    await user.click(askButton());

    const link = await within(log()).findByRole("link", { name: "LinkedIn" });
    expect(link).toHaveAttribute("href", LINKEDIN);
    expect(within(log()).queryByText(/@/)).not.toBeInTheDocument();
  });

  it("keeps the usual notice for a question typed by the visitor", async () => {
    const user = userEvent.setup();
    const { fetch, requests } = fakeFetch(
      chatError({ code: "unavailable", message: "Resting." }),
    );
    renderPage(fetch);

    await user.type(input(), "hello{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable/i);
    expect(requests).toHaveLength(1);
  });

  it("is a LinkedIn link without the chat: no JavaScript, or no agent in this build", () => {
    const html = renderToString(<ContactAsk linkedin={LINKEDIN} />);
    expect(html).toContain(`href="${LINKEDIN}"`);
    expect(html).not.toContain("ask my agent");

    render(<ContactAsk linkedin={LINKEDIN} />);
    expect(screen.getByRole("link", { name: /linkedin/i })).toHaveAttribute("href", LINKEDIN);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
