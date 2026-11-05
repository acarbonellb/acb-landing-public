import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { profile } from "@/shared/profile";
import { StatusLine } from "./status-line";

describe("StatusLine", () => {
  it("is the page footer and shows the copyright owner", () => {
    render(<StatusLine />);

    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      `© ${profile.name}`,
    );
  });
});
