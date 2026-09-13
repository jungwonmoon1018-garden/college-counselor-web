import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import DriftBanner from "./DriftBanner.jsx";

// The drift banner keys its display off the server's `status`: nothing to
// show when every activity is fresh, the write-story path when no story is
// saved, the review path when activities went stale. The server used to
// send no `status` at all, so the "you're up to date" message rendered as
// a warning banner on every visit.
function stubDrift(body) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input?.url;
    if (String(url).includes("/api/narrative/drift")) {
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return () => { globalThis.fetch = original; };
}

describe("DriftBanner", () => {
  let restore = null;
  afterEach(() => { cleanup(); if (restore) restore(); restore = null; });

  it("renders nothing when every activity is fresh", async () => {
    restore = stubDrift({ ok: true, status: "all_fresh", staleCount: 0, friendlyMessage: "Every activity's narrative fit was scored against your current narrative. You're up to date." });
    const { container } = render(<DriftBanner locale="en-US" onReview={() => {}} onWriteStory={() => {}} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });

  it("offers the review path when activities went stale, and the story path when none is saved", async () => {
    restore = stubDrift({ ok: true, status: "one_stale", staleCount: 1, friendlyMessage: "One activity was scored against an older narrative." });
    render(<DriftBanner locale="en-US" onReview={() => {}} onWriteStory={() => {}} />);
    expect(await screen.findByText("One activity was scored against an older narrative.")).toBeInTheDocument();
    expect(screen.getByText("Review activities")).toBeInTheDocument();
    cleanup();
    restore();
    restore = stubDrift({ ok: true, status: "no_active_narrative", staleCount: 0, friendlyMessage: "Save your story first." });
    render(<DriftBanner locale="en-US" onReview={() => {}} onWriteStory={() => {}} />);
    expect(await screen.findByText("Save your story first.")).toBeInTheDocument();
    expect(screen.queryByText("Review activities")).not.toBeInTheDocument();
  });
});
