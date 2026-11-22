import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { CookieNotice } from "./cookie-notice";

// The browser tests see a build with a key (CI's); a build without one, and
// the saved dismissal, are covered here (docs/analytics.md).
const notice = () => screen.queryByRole("region", { name: /cookie notice/i });

describe("CookieNotice", () => {
  beforeEach(() => localStorage.clear());

  it("renders nothing in a build without a project key", async () => {
    const { container } = render(<CookieNotice projectKey={undefined} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it("says the site uses an analytics cookie, in a build with a key", async () => {
    render(<CookieNotice projectKey="phc_test" />);

    expect(await screen.findByRole("region", { name: /cookie notice/i })).toHaveTextContent(
      /uses a cookie for analytics/i,
    );
    expect(screen.getByRole("button", { name: /ok/i })).toBeInTheDocument();
  });

  it("[ok] hides it and the browser remembers, so it doesn't come back", async () => {
    const { unmount } = render(<CookieNotice projectKey="phc_test" />);

    await userEvent.click(await screen.findByRole("button", { name: /ok/i }));
    expect(notice()).not.toBeInTheDocument();

    unmount();
    render(<CookieNotice projectKey="phc_test" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notice()).not.toBeInTheDocument();
  });

  it("still shows, and [ok] still hides it, when storage is unavailable", async () => {
    const { getItem, setItem } = Storage.prototype;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      render(<CookieNotice projectKey="phc_test" />);
      await userEvent.click(await screen.findByRole("button", { name: /ok/i }));
      expect(notice()).not.toBeInTheDocument();
    } finally {
      Storage.prototype.getItem = getItem;
      Storage.prototype.setItem = setItem;
    }
  });
});
