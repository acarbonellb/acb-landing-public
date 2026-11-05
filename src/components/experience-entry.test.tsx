import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Role } from "@/shared/profile";
import { ExperienceEntry } from "./experience-entry";

const role: Role = {
  slug: "engines",
  hash: "abc1234",
  company: "Analytical Engines",
  role: "Lead Analyst",
  place: "London / Remote",
  period: { from: 1842, to: null },
  description: "Builds general-purpose engines.",
  highlights: ["Wrote the first program.", "Translated Menabrea."],
  stack: ["Gears", "Punch cards"],
};

function toggle() {
  return screen.getByRole("button", { name: /git show abc1234/ });
}

describe("ExperienceEntry", () => {
  it("starts collapsed, showing the commit line and summary only", () => {
    render(<ExperienceEntry role={role} head={false} />);

    expect(
      screen.getByRole("heading", { name: "Lead Analyst" }),
    ).toBeInTheDocument();
    expect(screen.getByText("@ Analytical Engines")).toBeVisible();
    expect(screen.getByText("1842 — now · London / Remote")).toBeVisible();
    expect(screen.getByText("Builds general-purpose engines.")).toBeVisible();

    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Wrote the first program.")).not.toBeVisible();
    expect(screen.getByText("Gears")).not.toBeVisible();
  });

  it("expands to a diff of stack and highlights, and collapses again", async () => {
    const user = userEvent.setup();
    render(<ExperienceEntry role={role} head={false} />);

    await user.click(toggle());

    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByRole("region", { name: /git show abc1234/ });
    expect(toggle()).toHaveAttribute("aria-controls", details.id);
    for (const line of [...role.highlights, ...role.stack]) {
      expect(screen.getByText(line)).toBeVisible();
    }

    await user.click(toggle());

    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Wrote the first program.")).not.toBeVisible();
  });

  it("is operable from the keyboard", async () => {
    const user = userEvent.setup();
    render(<ExperienceEntry role={role} head={false} />);

    await user.tab();
    expect(toggle()).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");

    await user.keyboard(" ");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("marks the HEAD role", () => {
    render(<ExperienceEntry role={role} head />);

    expect(screen.getByText("(HEAD -> main)")).toBeInTheDocument();
  });
});
