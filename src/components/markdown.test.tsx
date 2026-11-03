import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

function renderMarkdown(text: string) {
  return render(<Markdown text={text} />).container;
}

describe("Markdown", () => {
  it("renders bold text without the asterisks", () => {
    const root = renderMarkdown("He is **remote** from Spain.");

    expect(screen.getByText("remote").tagName).toBe("STRONG");
    expect(root.textContent).toBe("He is remote from Spain.");
  });

  it("splits paragraphs on blank lines and renders bullet and numbered lists", () => {
    const root = renderMarkdown(
      "He has built:\n\n- Fraud Detection Agent\n* Portfolio Agent\n\nSteps:\n1. Email him\n2. Wait",
    );

    const paragraphs = [...root.querySelectorAll("p")].map((p) => p.textContent);
    expect(paragraphs).toEqual(["He has built:", "Steps:"]);
    const [bullets, numbered] = screen.getAllByRole("list");
    expect(bullets.tagName).toBe("UL");
    expect([...bullets.children].map((li) => li.textContent)).toEqual([
      "Fraud Detection Agent",
      "Portfolio Agent",
    ]);
    expect(numbered.tagName).toBe("OL");
    expect([...numbered.children].map((li) => li.textContent)).toEqual([
      "Email him",
      "Wait",
    ]);
  });

  it("renders italic and inline code, leaving code contents literal", () => {
    const root = renderMarkdown("Uses *TypeScript*, _daily_ and `**not bold**`.");

    expect(screen.getByText("TypeScript").tagName).toBe("EM");
    expect(screen.getByText("daily").tagName).toBe("EM");
    expect(screen.getByText("**not bold**").tagName).toBe("CODE");
    expect(root.querySelector("strong")).toBeNull();
  });

  it("leaves lone asterisks and snake_case words alone", () => {
    const root = renderMarkdown("5 * 3 = 15 and get_contact_info");

    expect(root.textContent).toBe("5 * 3 = 15 and get_contact_info");
    expect(root.querySelector("em")).toBeNull();
  });

  it("renders http(s) and mailto links that open safely in a new tab", () => {
    renderMarkdown(
      "See [GitHub](https://github.com/acarbonellb), [**mail**](mailto:a@b.dev) or [old](http://example.com).",
    );

    for (const [name, href] of [
      ["GitHub", "https://github.com/acarbonellb"],
      ["mail", "mailto:a@b.dev"],
      ["old", "http://example.com"],
    ]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("does not turn javascript:, data: or relative URLs into links", () => {
    const root = renderMarkdown(
      "[click](javascript:alert(1)) [x](JavaScript:alert(1)) [d](data:text/html,hi) [r](/admin)",
    );

    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(root.textContent).toContain("click");
    expect(root.innerHTML).not.toMatch(/href/i);
  });

  it("shows raw HTML from the model as text, never as elements", () => {
    const root = renderMarkdown(
      'Hi <img src=x onerror="alert(1)"> <script>alert(1)</script> <a href="https://x.dev">x</a>',
    );

    expect(root.querySelector("img, script, a")).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(root.textContent).toContain("<script>alert(1)</script>");
  });

  it.each([
    ["an unclosed bold", "He is **remo", "He is **remo"],
    ["half a link", "See [GitHub](https://git", "See [GitHub](https://git"],
    ["a bare list marker", "Agents:\n- Fraud\n-", "Agents:Fraud"],
    ["an unclosed code span", "Calls `get_pro", "Calls `get_pro"],
  ])("renders %s mid-stream as plain text", (_, text, expected) => {
    const root = renderMarkdown(text);

    expect(root.textContent).toBe(expected);
    expect(root.querySelector("a, strong, code")).toBeNull();
  });

  it("keeps a single line break inside a paragraph", () => {
    const root = renderMarkdown("Line one\nline two");

    expect(root.querySelectorAll("p")).toHaveLength(1);
    expect(root.querySelector("br")).not.toBeNull();
  });
});
