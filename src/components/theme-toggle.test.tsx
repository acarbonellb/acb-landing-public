import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./theme-toggle";

const theme = () => document.documentElement.getAttribute("data-theme");
const toggle = () =>
  userEvent.click(screen.getByRole("button", { name: "Toggle colour scheme" }));

describe("ThemeToggle", () => {
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", "night");
  });

  it("switches from Tokyo Night to Tokyo Light and saves the choice", async () => {
    render(<ThemeToggle />);

    await toggle();

    expect(theme()).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("switches back to Tokyo Night on a second click", async () => {
    render(<ThemeToggle />);

    await toggle();
    await toggle();

    expect(theme()).toBe("night");
    expect(localStorage.getItem("theme")).toBe("night");
  });
});
