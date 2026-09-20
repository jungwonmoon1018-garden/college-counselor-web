import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary.jsx";

function Bomb({ explode }) {
  if (explode) throw new Error("render kaboom");
  return <p>Intact content</p>;
}

describe("ErrorBoundary", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders children when nothing throws", () => {
    render(<ErrorBoundary><Bomb explode={false} /></ErrorBoundary>);
    expect(screen.getByText("Intact content")).toBeInTheDocument();
  });

  it("replaces a crashed tree with the recovery page and offers a reload", () => {
    // React logs the caught error and jsdom reports it as "uncaught" on the
    // window; keep the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const swallow = (event) => event.preventDefault();
    window.addEventListener("error", swallow);
    const reload = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, reload }, writable: true });

    try {
      render(<ErrorBoundary><Bomb explode /></ErrorBoundary>);

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(screen.queryByText("Intact content")).not.toBeInTheDocument();
      expect(screen.getByText(/render kaboom/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("error", swallow);
    }
  });
});
