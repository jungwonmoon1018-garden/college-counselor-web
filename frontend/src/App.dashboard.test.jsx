import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import App from "./App.jsx";

// The profile sidebar on the chat screen edits every standardized test
// (total, sections, date), every AP exam score and the class rank in place,
// and the auto-save syncs the edited profile to the backend. A returning
// student whose backend profile is populated lands on that screen.
function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

const backendProfile = {
  gpa: { unweighted: 3.9, weighted: null },
  classRank: null,
  courses: [{ name: "Calculus BC", type: "ap", grade: "A", year: "junior" }],
  apScores: [{ exam: "Statistics", score: 4, year: 2026 }],
  testScores: [{ test: "act", totalScore: 33, sections: { english: 35, math: 31, reading: 34, science: 32 } }],
  activities: [],
  majorInterest: "Computer Science",
  goals: [],
};

describe("Dashboard profile editing", () => {
  let syncBodies;

  beforeEach(() => {
    syncBodies = [];
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      if (method === "POST" && path.includes("/api/students/auth")) return json({ token: "tok_test_1", studentId: "stu_test_1" });
      if (path.includes("/api/students/budget")) return json({ grade: 11 });
      if (path.includes("/api/students/export")) return json({ profile: { name: "Jiyeon Kim" } });
      if (path.includes("/api/students/profile")) return json({ profile: backendProfile, metrics: [], milestoneCount: 0 });
      if (method === "POST" && path.includes("/api/students/sync")) {
        syncBodies.push(JSON.parse(options.body));
        return json({ synced: true, changesDetected: 0, changes: [] });
      }
      return json({});
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  async function signIn() {
    render(<App />);
    await screen.findByText("Welcome back");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jiyeon@school.edu" } });
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    // The populated backend profile routes straight to the app, whose
    // sidebar shows the recovered ACT with its four sections.
    await screen.findByText("E 35 · M 31 · R 34 · S 32", {}, { timeout: 15000 });
  }

  const lastSync = () => syncBodies[syncBodies.length - 1];

  it("edits an ACT section in place, re-derives the composite, and syncs it", async () => {
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Edit ACT score" }));
    const editor = screen.getByTestId("test-score-editor");
    fireEvent.change(within(editor).getByLabelText("ACT Math"), { target: { value: "34" } });
    // (35 + 34 + 34 + 32) / 4 = 33.75 → 34
    expect(within(editor).getByLabelText("ACT total")).toHaveValue(34);
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("E 35 · M 34 · R 34 · S 32")).toBeInTheDocument();
    await waitFor(() => {
      expect(lastSync()?.profile?.testScores?.[0]).toEqual({ test: "act", totalScore: 34, sections: { english: 35, math: 34, reading: 34, science: 32 } });
    }, { timeout: 5000 });
  }, 30000);

  it("rejects an out-of-range section instead of saving it", async () => {
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Edit ACT score" }));
    const editor = screen.getByTestId("test-score-editor");
    fireEvent.change(within(editor).getByLabelText("ACT English"), { target: { value: "37" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await within(editor).findByRole("alert")).toHaveTextContent("ACT English must be 1-36");
    // The editor stays open; cancelling shows the saved score untouched.
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("E 35 · M 31 · R 34 · S 32")).toBeInTheDocument();
    expect(syncBodies.every((body) => body.profile.testScores[0].sections.english === 35)).toBe(true);
  }, 30000);

  it("adds a new SAT score with sections from the dashboard", async () => {
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "+ Add test score" }));
    const editor = screen.getByTestId("test-score-editor");
    fireEvent.change(within(editor).getByLabelText("SAT Reading & Writing"), { target: { value: "720" } });
    fireEvent.change(within(editor).getByLabelText("SAT Math"), { target: { value: "780" } });
    expect(within(editor).getByLabelText("SAT total")).toHaveValue(1500);
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("R&W 720 · M 780")).toBeInTheDocument();
    await waitFor(() => {
      expect(lastSync()?.profile?.testScores?.[1]).toEqual({ test: "sat", totalScore: 1500, sections: { readingWriting: 720, math: 780 } });
    }, { timeout: 5000 });
  }, 30000);

  it("edits, adds and removes AP exam scores, and records a class rank", async () => {
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Edit AP Statistics score" }));
    let editor = screen.getByTestId("ap-score-editor");
    fireEvent.change(within(editor).getByLabelText("AP score"), { target: { value: "5" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(lastSync()?.profile?.apScores).toEqual([{ exam: "Statistics", score: 5, year: 2026 }]);
    }, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "+ Add AP score" }));
    editor = screen.getByTestId("ap-score-editor");
    fireEvent.change(within(editor).getByLabelText("AP exam"), { target: { value: "Calculus BC" } });
    fireEvent.change(within(editor).getByLabelText("AP exam year"), { target: { value: "2025" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(lastSync()?.profile?.apScores).toEqual([{ exam: "Statistics", score: 5, year: 2026 }, { exam: "Calculus BC", score: 5, year: 2025 }]);
    }, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Edit AP Statistics score" }));
    editor = screen.getByTestId("ap-score-editor");
    fireEvent.click(within(editor).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(lastSync()?.profile?.apScores).toEqual([{ exam: "Calculus BC", score: 5, year: 2025 }]);
    }, { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "+ Add class rank" }));
    editor = screen.getByTestId("class-rank-editor");
    fireEvent.change(within(editor).getByLabelText("Class rank"), { target: { value: "12" } });
    fireEvent.change(within(editor).getByLabelText("Class size"), { target: { value: "400" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("top 3% (12 of 400)")).toBeInTheDocument();
    await waitFor(() => {
      expect(lastSync()?.profile?.classRank).toEqual({ topPercent: 3, rank: 12, size: 400 });
    }, { timeout: 5000 });
  }, 40000);
});
