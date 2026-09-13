import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import SpikeFinder from "./SpikeFinder.jsx";

// One open, one fetch. The parent's target list loads after sign-in, so a
// panel mounted before it arrived used to fetch bare and then again with
// the list — two model re-ranks. The server resolves the saved schools
// itself when none are sent and reports them, so when they match the list
// that arrives nothing is fetched again; a list that differs is.
function spikeBody(targetSchools) {
  return {
    ok: true, count: 2, engine: "llm", targetSchools,
    leading: [{ id: "a", ecName: "Nanoparticle review", tierLabel: "tier_3_developing", rankScore: 0.54, factors: { dedication: 0.24, achievement: 0.47, leadership: 0.71, prestige: 0, major_spike: 0.8, narrative_fit: 1 } }],
    supporting: [],
    wellbeing: { totalWeeklyHours: 8, sustainableCap: 20, cautionLine: 30, hardCeiling: 40, overCommitted: false, message: "Within a sustainable range." },
    friendlyLegendI18n: { tiers: { tier_3_developing: { short: "Developing" } } },
  };
}

function stubSpike() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input) => {
    const url = String(typeof input === "string" ? input : input?.url);
    if (!url.includes("/api/ec/spike")) throw new Error(`unexpected fetch ${url}`);
    calls.push(url);
    const q = new URL(url, "http://x").searchParams.get("targetSchools");
    // With no list sent, the server tunes for the saved goals.
    const targets = q ? q.split(",") : ["NYU", "Rice"];
    return new Response(JSON.stringify(spikeBody(targets)), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("SpikeFinder fetches once per open", () => {
  let restore = null;
  afterEach(() => { cleanup(); if (restore) restore(); restore = null; });

  it("does not refetch when the target list that arrives is the one the server already tuned for", async () => {
    const stub = stubSpike();
    restore = stub.restore;
    const { rerender } = render(<SpikeFinder locale="en-US" targetSchools={[]} />);
    expect(await screen.findByText("Nanoparticle review")).toBeInTheDocument();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).not.toContain("targetSchools=");
    rerender(<SpikeFinder locale="en-US" targetSchools={["NYU", "Rice"]} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.calls).toHaveLength(1);
    expect(screen.getByText("Developing")).toBeInTheDocument();
    // A different list (the student edited targets) is a new read.
    rerender(<SpikeFinder locale="en-US" targetSchools={["NYU"]} />);
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    expect(stub.calls[1]).toContain("targetSchools=NYU");
  });
});
