import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MobileMenu } from "./mobile-menu";

const items = [
  { href: "#about", label: "about" },
  { href: "#stack", label: "stack" },
  { href: "#contact", label: "contact" },
];

function menuButton() {
  return screen.getByRole("button", { name: "Section menu" });
}

describe("MobileMenu", () => {
  it("starts closed, with a named button that reports it is collapsed", () => {
    render(<MobileMenu items={items} />);

    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("opens on click to list every section, and closes on a second click", async () => {
    const user = userEvent.setup();
    render(<MobileMenu items={items} />);

    await user.click(menuButton());

    expect(menuButton()).toHaveAttribute("aria-expanded", "true");
    const nav = within(screen.getByRole("navigation", { name: "Sections" }));
    expect(
      nav.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      [expect.stringContaining("about"), "#about"],
      [expect.stringContaining("stack"), "#stack"],
      [expect.stringContaining("contact"), "#contact"],
    ]);

    await user.click(menuButton());

    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("opens from the keyboard and moves focus to the first section", async () => {
    const user = userEvent.setup();
    render(<MobileMenu items={items} />);

    await user.tab();
    expect(menuButton()).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(menuButton()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /about/ })).toHaveFocus();
  });

  it("closes on Escape and gives focus back to the button", async () => {
    const user = userEvent.setup();
    render(<MobileMenu items={items} />);

    menuButton().focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");

    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
    expect(menuButton()).toHaveFocus();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("closes once a section is chosen", async () => {
    const user = userEvent.setup();
    render(<MobileMenu items={items} />);

    await user.click(menuButton());
    await user.click(screen.getByRole("link", { name: /stack/ }));

    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("moves between sections with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<MobileMenu items={items} />);

    menuButton().focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("link", { name: /stack/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("link", { name: /about/ })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("link", { name: /contact/ })).toHaveFocus();
  });

  it("closes when focus leaves the menu", async () => {
    const user = userEvent.setup();
    render(
      <>
        <MobileMenu items={items} />
        <button type="button">elsewhere</button>
      </>,
    );

    await user.click(menuButton());
    await user.click(screen.getByRole("button", { name: "elsewhere" }));

    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
  });
});
