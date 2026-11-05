import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

function renderMarkdown(text: string) {
  return render(<Markdown text={text} />).container;
}

describe("Markdown", () => {
  it("renders bold text without the asterisks", () => {
    const root = renderMarkdown("He is **remote** from Spain.");

    expect(screen.getByRole("strong")).toHaveTextContent("remote");
    expect(root.textContent).toBe("He is remote from Spain.");
  });

  it("splits paragraphs on blank lines and renders bullet and numbered lists", () => {
    const root = renderMarkdown(
      "He has built:\n\n- Fraud Detection Agent\n* Portfolio Agent\n\nSteps:\n1. Email him\n2. Wait",
    );

    const paragraphs = screen.getAllByRole("paragraph").map((p) => p.textContent);
    expect(paragraphs).toEqual(["He has built:", "Steps:"]);
    const items = (list: HTMLElement) =>
      within(list).getAllByRole("listitem").map((li) => li.textContent);
    const [bullets, numbered] = screen.getAllByRole("list");
    expect(items(bullets)).toEqual(["Fraud Detection Agent", "Portfolio Agent"]);
    expect(items(numbered)).toEqual(["Email him", "Wait"]);
    expect(root.textContent).not.toMatch(/^\s*[-*]|\d\./m);
  });

  it("renders italic and inline code, leaving code contents literal", () => {
    renderMarkdown("Uses *TypeScript*, _daily_ and `**not bold**`.");

    expect(screen.getAllByRole("emphasis").map((e) => e.textContent)).toEqual([
      "TypeScript",
      "daily",
    ]);
    expect(screen.getByRole("code")).toHaveTextContent("**not bold**");
    expect(screen.queryByRole("strong")).toBeNull();
  });

  it("leaves lone asterisks and snake_case words alone", () => {
    const root = renderMarkdown("5 * 3 = 15 and get_contact_info");

    expect(root.textContent).toBe("5 * 3 = 15 and get_contact_info");
    expect(screen.queryByRole("emphasis")).toBeNull();
  });

  it("renders links to the hosts the tools return in a new tab, and mailto links in place", () => {
    renderMarkdown(
      "See [GitHub](https://github.com/acarbonellb), [**mail**](mailto:a@b.example), [LinkedIn](https://www.linkedin.com/in/someone/) or [the site](https://albertocarbonell.dev/#agent).",
    );

    for (const [name, href] of [
      ["GitHub", "https://github.com/acarbonellb"],
      ["LinkedIn", "https://www.linkedin.com/in/someone/"],
      ["the site", "https://albertocarbonell.dev/#agent"],
    ]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    const mail = screen.getByRole("link", { name: "mail" });
    expect(mail).toHaveAttribute("href", "mailto:a@b.example");
    expect(mail).not.toHaveAttribute("target");
  });

  it("links a bare email address to mailto:, keeping the sentence's punctuation out", () => {
    const root = renderMarkdown(
      "Email him at **ada.l+cv@mail.example.org**. Or `not@linked.example` in code.",
    );

    const link = screen.getByRole("link", { name: "ada.l+cv@mail.example.org" });
    expect(link).toHaveAttribute("href", "mailto:ada.l+cv@mail.example.org");
    expect(link).not.toHaveAttribute("target");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(root.textContent).toBe("Email him at ada.l+cv@mail.example.org. Or not@linked.example in code.");
  });

  it("does not link an address twice inside a mailto link's label", () => {
    renderMarkdown("Write to [a@b.example](mailto:a@b.example).");

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link")).toHaveAttribute("href", "mailto:a@b.example");
  });

  it("does not turn javascript:, data: or relative URLs into links", () => {
    const root = renderMarkdown(
      "[click](javascript:alert(1)) [x](JavaScript:alert(1)) [d](data:text/html,hi) [r](/admin)",
    );

    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(root.textContent).toBe("click x d r");
  });

  it("renders a link to any other host as its label, as plain text", () => {
    const root = renderMarkdown(
      "[a](https://evil.example/login) [b](https://github.com.evil.example/x) [c](https://github.com@evil.example/) [d](http://github.com/acarbonellb) [e](https://github.com:8443/x) [f](https://gist.github.com/x)",
    );

    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(root.textContent).toBe("a b c d e f");
  });

  it("shows raw HTML from the model as text, never as elements", () => {
    const root = renderMarkdown(
      'Hi <img src=x onerror="alert(1)"> <script>alert(1)</script> <a href="https://x.dev">x</a>',
    );

    expect(screen.queryAllByRole("img", { hidden: true })).toEqual([]);
    expect(screen.queryAllByRole("link")).toEqual([]);
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
    for (const role of ["link", "strong", "code"]) {
      expect(screen.queryByRole(role)).toBeNull();
    }
  });

  it("keeps a list together when its items are separated by blank lines", () => {
    renderMarkdown("Steps:\n\n1. Email him\n\n2. Wait\n\nThanks.");

    const [list] = screen.getAllByRole("list");
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Email him",
      "Wait",
    ]);
    expect(screen.getAllByRole("paragraph").map((p) => p.textContent)).toEqual([
      "Steps:",
      "Thanks.",
    ]);
  });

  it("keeps a single line break inside a paragraph", () => {
    renderMarkdown("Line one\nline two");

    expect(screen.getAllByRole("paragraph")).toHaveLength(1);
    expect(screen.getByRole("paragraph")).toHaveTextContent("Line oneline two");
  });
});
