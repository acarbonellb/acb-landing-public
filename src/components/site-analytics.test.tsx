import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SiteAnalytics } from "./site-analytics";

// What the browser tests can't see: CI's build has the key, so a build
// without one is covered here (docs/analytics.md).
describe("SiteAnalytics", () => {
  it("never requests the SDK in a build without a project key", async () => {
    const load = vi.fn(async () => ({ init: vi.fn(), capture: vi.fn() }));
    const { container } = render(<SiteAnalytics projectKey={undefined} load={load} />);

    // Give a load that would follow hydration time to happen.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(load).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("loads the SDK once and starts it with the key in a build with one", async () => {
    const init = vi.fn();
    const load = vi.fn(async () => ({ init, capture: vi.fn() }));
    render(<SiteAnalytics projectKey="phc_test" load={load} />);

    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0][0]).toBe("phc_test");
  });

  it("leaves the page as it is when the SDK fails to load", async () => {
    const load = vi.fn(async () => {
      throw new Error("blocked");
    });
    const { container } = render(<SiteAnalytics projectKey="phc_test" load={load} />);

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });
});
