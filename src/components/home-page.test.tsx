import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HomePage } from "./home-page";

const summary = JSON.stringify({
  sets: [
    {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      cases: 3,
      kinds: { on_topic: 3 },
      leaks: { n: 0, of: 0 },
    },
  ],
});

describe("HomePage", () => {
  it("opens with a skip link to the main content", () => {
    render(<HomePage evalSummary={summary} />);

    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveTextContent("Skip to content");
    expect(links[0]).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("renders the hero, then every section in page order", () => {
    render(<HomePage evalSummary={summary} />);

    const main = within(screen.getByRole("main"));
    expect(main.getAllByRole("heading")[0]).toBe(main.getByRole("heading", { level: 1 }));
    const sections = main.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(sections).toEqual(["01.about", "02.stack", "03.experience", "04.projects", "05.ask my agent", "06.contact"]);
  });

  it("shows the eval results it is given on the Portfolio Agent card", () => {
    render(<HomePage evalSummary={summary} />);

    expect(
      screen.getByText("3 eval cases (and counting) · 0 leaks · on Claude Haiku 5.5 · replayed in CI"),
    ).toBeInTheDocument();
  });
});
