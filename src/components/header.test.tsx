import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sections } from "@/lib/sections";
import { Header } from "./header";

describe("Header", () => {
  it("links to every section of the page", () => {
    render(<Header />);

    const nav = within(screen.getByRole("navigation"));
    const targets = nav
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));

    expect(targets).toEqual([
      "#about",
      "#stack",
      "#experience",
      "#projects",
      "#agent",
      "#contact",
    ]);
  });

  it("labels each link with the registry's nav label, numbered by position", () => {
    render(<Header />);

    const labels = within(screen.getByRole("navigation"))
      .getAllByRole("link")
      .map((link) => link.textContent);

    expect(labels).toEqual(sections.map((s, i) => `${i + 1}:${s.nav}`));
  });

  it("offers a section menu for small screens", () => {
    render(<Header />);

    expect(
      screen.getByRole("button", { name: "Section menu" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("offers the colour scheme toggle", () => {
    render(<Header />);

    expect(
      screen.getByRole("button", { name: "Toggle colour scheme" }),
    ).toBeInTheDocument();
  });
});
