import { describe, expect, it } from "vitest";
import { linkHosts, linkHostsIn } from "./link-hosts";

describe("link hosts", () => {
  it("allows the site and the hosts of the content's links", () => {
    expect([...linkHosts].sort()).toEqual([
      "albertocarbonell.dev",
      "github.com",
      "www.linkedin.com",
    ]);
  });

  it("follows the content: a link added anywhere in it allows its host", () => {
    const content = {
      profile: { links: { github: "https://github.com/someone" } },
      agentProjects: [
        { name: "X", links: [{ label: "demo", href: "https://demo.example.org/x" }] },
      ],
    };

    expect([...linkHostsIn(content)].sort()).toEqual(["demo.example.org", "github.com"]);
  });

  it("ignores text, on-page anchors and non-https URLs", () => {
    const content = {
      text: "Remote from Spain",
      href: "#agent",
      old: "http://old.example.org",
      mail: "mailto:a@b.example",
    };

    expect(linkHostsIn(content).size).toBe(0);
  });
});
