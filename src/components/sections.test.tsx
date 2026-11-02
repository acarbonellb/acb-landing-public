import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { experience, profile, projects, stack } from "@/content/profile";
import {
  About,
  Agent,
  Contact,
  Experience,
  Hero,
  Projects,
  Stack,
} from "./sections";

// Sections render whatever the content module holds, so these tests read the
// expected values from it: they keep passing when the CV text changes.

describe("Hero", () => {
  it("shows the name as the page heading, the role and the profile links", () => {
    render(<Hero />);

    expect(
      screen.getByRole("heading", { level: 1, name: profile.name }),
    ).toBeInTheDocument();
    expect(screen.getByText(profile.role)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /github/ })).toHaveAttribute(
      "href",
      profile.links.github,
    );
    expect(screen.getByRole("link", { name: /linkedin/ })).toHaveAttribute(
      "href",
      profile.links.linkedin,
    );
  });
});

describe("About", () => {
  it("shows every paragraph of the about text", () => {
    render(<About />);

    expect(screen.getByRole("heading", { name: /about/ })).toBeInTheDocument();
    for (const paragraph of profile.about) {
      expect(screen.getByText(paragraph)).toBeInTheDocument();
    }
  });
});

describe("Stack", () => {
  it("lists every skill group and item", () => {
    render(<Stack />);

    for (const { group, items } of stack) {
      expect(screen.getByText(group)).toBeInTheDocument();
      for (const item of items) {
        expect(screen.getByText(`"${item}"`)).toBeInTheDocument();
      }
    }
  });
});

describe("Experience", () => {
  it("shows each job's role, company and period", () => {
    render(<Experience />);

    for (const job of experience) {
      expect(
        screen.getByRole("heading", { name: job.role }),
      ).toBeInTheDocument();
      expect(screen.getByText(`@ ${job.company}`)).toBeInTheDocument();
      expect(screen.getByText(job.period)).toBeInTheDocument();
    }
  });
});

describe("Projects", () => {
  it("shows each project with its description", () => {
    render(<Projects />);

    for (const project of projects) {
      expect(
        screen.getByRole("heading", { name: `./${project.name}` }),
      ).toBeInTheDocument();
      expect(screen.getByText(project.description)).toBeInTheDocument();
    }
  });
});

describe("Agent", () => {
  it("has the ask-my-agent section heading", () => {
    render(<Agent />);

    expect(
      screen.getByRole("heading", { name: /ask my agent/ }),
    ).toBeInTheDocument();
  });
});

describe("Contact", () => {
  it("links to the contact email", () => {
    render(<Contact />);

    expect(
      screen.getByRole("link", { name: profile.links.email }),
    ).toHaveAttribute("href", `mailto:${profile.links.email}`);
  });
});
