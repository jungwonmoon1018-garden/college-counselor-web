import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CourseSequencer from "./CourseSequencer.jsx";

// The concept read beside a ladder course: with an AP exam on file the
// exam leads and the chat-derived read follows in parentheses, so a 0.43
// never contradicts a 5; without an exam the chat read speaks for itself.
function stubRecommendations(body) {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input?.url;
    if (String(url).includes("/api/courses/recommendations")) {
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return () => { globalThis.fetch = original; };
}

describe("CourseSequencer concept tags", () => {
  let restore = null;
  afterEach(() => { cleanup(); if (restore) restore(); restore = null; });

  it("leads with the AP exam score and keeps the chat read in parentheses", async () => {
    restore = stubRecommendations({
      ok: true,
      lanes: {
        inference: {
          bucket: "biology", majorLabel: "Biology", isGenericLadder: false, majorRelevantCourseCount: 2,
          label: "Inferred from the typical structure of this major — not a school requirement.",
          have: [
            { id: "bio", name: "AP Biology", level: "core", why: "The most major-relevant course.", conceptSignal: { apSubject: "AP_BIOLOGY", subjectVector: 0.43, examScore: 5, basis: "exam", status: "solid" } },
            { id: "chem", name: "AP Chemistry", level: "core", why: "Chemistry foundation.", conceptSignal: { apSubject: "AP_CHEMISTRY", examScore: 2, basis: "exam", status: "developing" } },
          ],
          missing: [],
        },
        coaching: {
          label: "Non-binding coaching suggestions.",
          next: [{ id: "stats", name: "AP Statistics", level: "recommended", suggestion: "You might consider AP Statistics.", conceptSignal: { apSubject: "AP_STATISTICS", subjectVector: 0.35, basis: "chat", status: "developing" } }],
        },
        verified: [],
      },
    });
    render(<CourseSequencer locale="en-US" />);
    expect(await screen.findByText("AP exam 5 · concepts solid (chat read 0.43)")).toBeInTheDocument();
    expect(screen.getByText("AP exam 2 · concepts developing")).toBeInTheDocument();
    expect(screen.getByText("concept mastery developing (0.35)")).toBeInTheDocument();
  });
});
