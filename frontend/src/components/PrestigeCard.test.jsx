import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PrestigeCard from "./PrestigeCard.jsx";

// The prestige card shows what the read matched and where it found the
// level (the activity's description, here), the source label the backend
// localizes, the rationale verbatim, and the organizer's pages.
function stubPrestige(body) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  })));
}

describe("PrestigeCard", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows the level read from the description, the source, the rationale and the organizer's pages", async () => {
    stubPrestige({
      ok: true,
      ecName: "Math Team",
      score: 0.72,
      source: "benchmark",
      level: "AIME qualifier",
      matchedIn: "description",
      catalogMatch: { activityId: "math_olympiad", activityName: "MAA American Mathematics Competitions", level: "AIME qualifier", confidence: 1 },
      rationale: "Matched the seeded Math Olympiad (AMC/AIME/USAMO/IMO) benchmark at the \"AIME qualifier\" level from your description. AIME qualification is a selective national math achievement in the MAA pathway.",
      sourcesCited: ["https://maa.org/student-programs/amc/"],
      friendly: { short: "Benchmark match", summary: "Matched a seeded competition benchmark at the level your activity states; the rationale names the level." },
    });
    render(<PrestigeCard ecName="Math Team" />);
    const card = await screen.findByTestId("prestige-card");
    expect(card).toHaveTextContent("Score 0.72");
    expect(card).toHaveTextContent("Benchmark match");
    expect(card).toHaveTextContent("Level: AIME qualifier · MAA American Mathematics Competitions");
    expect(card).toHaveTextContent("from your description");
    expect(card).toHaveTextContent("the rationale names the level");
    expect(screen.getByRole("link", { name: "maa.org" })).toHaveAttribute("href", "https://maa.org/student-programs/amc/");
  });

  it("tells the student what to write when nothing in the catalog matched", async () => {
    stubPrestige({
      ok: true,
      ecName: "Food Bank",
      score: 0,
      source: "unavailable",
      level: null,
      rationale: "Nothing in the reviewed benchmarks or the official competition catalog matches \"Food Bank\" or its description. If this is a competition or a selective program, name it and the level you reached in the activity description.",
      sourcesCited: [],
      friendly: { short: "No catalog match", summary: "Nothing in the reviewed benchmarks or official catalog matches this activity yet." },
    });
    render(<PrestigeCard ecName="Food Bank" />);
    const card = await screen.findByTestId("prestige-card");
    expect(card).toHaveTextContent("Score 0.00");
    expect(card).toHaveTextContent("No catalog match");
    expect(card).toHaveTextContent("name it and the level you reached");
    expect(card).not.toHaveTextContent("Level:");
    expect(card).not.toHaveTextContent("Sources cited");
  });
});
