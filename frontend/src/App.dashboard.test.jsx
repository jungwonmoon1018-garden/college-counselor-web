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
  // What the sync answers; a test may replace it (a refused save, a save
  // with a field set aside).
  let syncReply;
  // Every request the app made, and answers a test adds for other routes.
  let calls;
  let routeReply;

  beforeEach(() => {
    syncBodies = [];
    syncReply = null;
    calls = [];
    routeReply = null;
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      calls.push({ method, path, body: typeof options.body === "string" ? options.body : null });
      const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
      const routed = routeReply?.(path, method, options, json);
      if (routed) return routed;
      if (method === "POST" && path.includes("/api/students/auth")) return json({ token: "tok_test_1", studentId: "stu_test_1" });
      if (path.includes("/api/students/budget")) return json({ grade: 11 });
      if (path.includes("/api/students/export")) return json({ profile: { name: "Jiyeon Kim" } });
      if (path.includes("/api/students/profile")) return json({ profile: backendProfile, metrics: [], milestoneCount: 0 });
      if (method === "POST" && path.includes("/api/students/sync")) {
        syncBodies.push(JSON.parse(options.body));
        if (syncReply) return syncReply(json);
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

    // The same exam and year again is refused (profile/ap-entry.js); a year
    // whose scores are not out yet too.
    fireEvent.click(screen.getByRole("button", { name: "+ Add AP score" }));
    editor = screen.getByTestId("ap-score-editor");
    fireEvent.change(within(editor).getByLabelText("AP exam"), { target: { value: "Calculus BC" } });
    fireEvent.change(within(editor).getByLabelText("AP exam year"), { target: { value: "2025" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent("AP Calculus BC (2025) is already on your list.");
    fireEvent.change(within(editor).getByLabelText("AP exam year"), { target: { value: "2099" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent(/Enter the year you took the exam, 2000–\d{4}\. Scores come out in July\./);
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(lastSync()?.profile?.apScores).toHaveLength(2);

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

  it("edits the GPA, refuses a missed decimal, and syncs a GPA in range", async () => {
    await signIn();
    fireEvent.doubleClick(screen.getByText("3.9"));
    const editor = screen.getByTestId("gpa-editor");
    fireEvent.change(within(editor).getByLabelText("Unweighted GPA"), { target: { value: "39" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await within(editor).findByRole("alert")).toHaveTextContent("An unweighted GPA is between 0 and 5");
    expect(syncBodies.every((body) => body.profile.gpa.unweighted === 3.9)).toBe(true);

    fireEvent.change(within(editor).getByLabelText("Unweighted GPA"), { target: { value: "3.95" } });
    fireEvent.change(within(editor).getByLabelText("Weighted GPA"), { target: { value: "4.4" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(lastSync()?.profile?.gpa).toEqual({ unweighted: 3.95, weighted: 4.4 });
    }, { timeout: 5000 });
    expect(screen.queryByTestId("gpa-editor")).not.toBeInTheDocument();
  }, 30000);

  it("says when the server refuses a save, and names what it set aside", async () => {
    // A refused save used to show as synced: authedFetch resolves on 413.
    syncReply = () => ({ ok: false, status: 413, json: async () => ({ error: "Request body too large." }), text: async () => "" });
    await signIn();
    // Signing in sends nothing on its own since the auto-save tracks what the
    // server already holds (a stale device used to overwrite newer data), so
    // the first edit is what goes out and meets the 413.
    fireEvent.click(screen.getByRole("button", { name: "Edit AP Statistics score" }));
    const apEditor = screen.getByTestId("ap-score-editor");
    fireEvent.change(within(apEditor).getByLabelText("AP score"), { target: { value: "5" } });
    fireEvent.click(within(apEditor).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Your profile is too large to save — shorten a long activity description and try again.", {}, { timeout: 5000 })).toBeInTheDocument();

    // A save that lands with a field set aside says which one.
    syncReply = (json) => json({ synced: true, changesDetected: 0, changes: [], setAside: [{ field: "testScores", reason: "invalid_entry", count: 1 }] });
    fireEvent.click(screen.getByRole("button", { name: "+ Add class rank" }));
    const editor = screen.getByTestId("class-rank-editor");
    fireEvent.change(within(editor).getByLabelText("Top percent"), { target: { value: "5" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved, except 1 test score, which couldn't be read — check it in your profile.", {}, { timeout: 5000 })).toBeInTheDocument();
  }, 30000);

  // input-12: the note named the set-aside score, but the sidebar showed
  // every score alike. The row the server set aside is marked where it is,
  // in the student's language, with a way to fix or remove it.
  it("marks the exact score a save set aside and offers to fix or remove it", async () => {
    syncReply = (json) => {
      const sent = syncBodies[syncBodies.length - 1];
      const actAt = (sent.profile.testScores || []).findIndex((t) => t.test === "act");
      if (actAt < 0) return json({ synced: true, changes: [], setAside: [] });
      return json({ synced: true, changes: [], setAside: [{ field: "testScores", reason: "invalid_entry", count: 1, entries: [{ index: actAt, label: "ACT 33", message: "ACT English must be 1-36.", kept: true }] }] });
    };
    await signIn();
    // Korean first: the save's note and the row's mark follow the app's language.
    fireEvent.click(screen.getByRole("button", { name: "한국어" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add class rank" }));
    let editor = screen.getByTestId("class-rank-editor");
    fireEvent.change(within(editor).getByLabelText("Top percent"), { target: { value: "5" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/저장했어요\. 다만 다음 항목은 저장하지 못했어요: ACT 33/, {}, { timeout: 5000 })).toBeInTheDocument();
    const marked = await screen.findByTestId("set-aside-row");
    expect(marked).toHaveTextContent("E 35 · M 31 · R 34 · S 32");
    expect(within(marked).getByRole("note")).toHaveTextContent("저장하지 못했어요: 범위를 벗어났거나 읽을 수 없는 값이에요. 이전에 저장된 값을 그대로 쓰고 있어요.");
    // Only that row: the AP score that saved is not marked.
    expect(screen.getAllByTestId("set-aside-row")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(within(screen.getByTestId("set-aside-row")).getByRole("note")).toHaveTextContent("Not saved: ACT English must be 1-36. Your saved version is still the one used.");
    // Fix opens that row's editor.
    fireEvent.click(within(screen.getByTestId("set-aside-row")).getByRole("button", { name: "Fix" }));
    editor = screen.getByTestId("test-score-editor");
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    // Remove takes it off, the next save carries no ACT, and the mark goes.
    fireEvent.click(within(screen.getByTestId("set-aside-row")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(lastSync()?.profile?.testScores).toEqual([]), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId("set-aside-row")).not.toBeInTheDocument());
    expect(screen.queryByText("E 35 · M 31 · R 34 · S 32")).not.toBeInTheDocument();
  }, 40000);

  // ui-12: the evidence line under an expanded activity was English in a
  // Korean session, because the sidebar never passed it the locale.
  it("shows an activity's evidence in the app's language", async () => {
    routeReply = (path, method, options, json) => {
      if (path.includes("/api/students/profile")) {
        return json({ profile: { ...backendProfile, activities: [{ id: "a1", name: "Robotics Club", role: "Captain", category: "stem" }] }, metrics: [], milestoneCount: 0 });
      }
      return null;
    };
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "한국어" }));
    fireEvent.click(await screen.findByText("Robotics Club"));
    expect(await screen.findByText(/증빙 자료/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/^Evidence/)).not.toBeInTheDocument();
  }, 40000);

  it("folds a sidebar section from its heading and remembers the fold on the device", async () => {
    await signIn();
    // The AP exam scores section holds the recovered Statistics 4.
    const heading = screen.getByRole("button", { name: "AP exam scores (1)" });
    expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Statistics")).toBeVisible();
    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Statistics")).not.toBeVisible();
    expect(JSON.parse(window.localStorage.getItem("cc.sidebar.collapsed"))).toEqual({ "ap-scores": true });
    // The other sections are untouched, and the Chats heading keeps its action.
    expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "+ New" })).toBeInTheDocument();
  }, 40000);

  // On a phone the sidebar is a drawer over the chat and covers the header's
  // toggle, so it has to close from inside: its own × and the dimmed backdrop.
  it("closes the sidebar from its own close button and from the backdrop", async () => {
    await signIn();
    const sidebar = screen.getByRole("complementary", { name: "Student profile and planning tools" });
    const open = () => fireEvent.click(screen.getByRole("button", { name: "▶" }));
    open();
    expect(sidebar).toHaveClass("is-open");
    fireEvent.click(within(sidebar).getByRole("button", { name: "Close sidebar" }));
    expect(sidebar).toHaveClass("is-closed");
    expect(screen.queryByTestId("sidebar-backdrop")).not.toBeInTheDocument();
    open();
    fireEvent.click(screen.getByTestId("sidebar-backdrop"));
    expect(sidebar).toHaveClass("is-closed");
  }, 40000);

  // The send path crosses five modules since App.jsx was split (ChatScreen →
  // chat-send → chat-orchestrator → chat-client, with the prompts from
  // agent-prompts). A course question is routed by the orchestrator's keyword
  // gate without a gatekeeper call; the academics agent answers and the reply
  // renders in the log.
  it("sends a course question to the academics agent and shows the reply", async () => {
    const chatCalls = [];
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      if (!path.includes("/api/chat")) return baseFetch(url, options);
      const body = JSON.parse(options.body);
      chatCalls.push({ path, headers: options.headers, body });
      const system = String(body.system || "");
      let answer = "Take AP Physics C next year; it builds on your Calculus BC.";
      if (/CLASSIFY the student's message/.test(system)) answer = JSON.stringify({ category: "safe_academic", reason: "course planning", route_to: ["academics"] });
      else if (/You validate responses/.test(system)) answer = JSON.stringify({ passed: true, issues: [], cleaned_response: "" });
      return { ok: true, status: 200, json: async () => ({ answer }), text: async () => JSON.stringify({ answer }) };
    }));
    await signIn();
    const box = screen.getByPlaceholderText(/Ask about academics, ECs, colleges, or strategy/);
    fireEvent.change(box, { target: { value: "Which science course should I take senior year?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/Take AP Physics C next year/, {}, { timeout: 15000 })).toBeInTheDocument();
    // The transport carried the session and the locale on every call.
    expect(chatCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of chatCalls) {
      expect(call.path).toContain("/api/chat?locale=");
      expect(call.headers.Authorization).toBe("Bearer tok_test_1");
    }
    expect(chatCalls.some((c) => JSON.stringify(c.body.messages || []).includes("Which science course should I take senior year?"))).toBe(true);
    expect(screen.getByRole("log")).toHaveTextContent("Which science course should I take senior year?");
  }, 40000);

  // ui-9: the ninth school used to be cut from the list after the input had
  // cleared, while its deadlines (and the model-backed calendar read behind
  // them) were still created for a school the student could not see.
  it("tells the student the target list is full and creates nothing for a ninth school", async () => {
    const eight = ["Rice University", "Duke University", "Emory University", "Tufts University", "Brown University", "Yale University", "Vanderbilt University", "Northwestern University"];
    window.localStorage.setItem("cc_targets_jiyeon@school.edu", JSON.stringify(eight));
    await signIn();
    expect(await screen.findByRole("button", { name: "Remove Northwestern University" })).toBeInTheDocument();
    expect(screen.getByTestId("target-cap-note")).toHaveTextContent("Your target list holds 8 schools, the most it can. Remove one to add another.");
    const input = screen.getByLabelText("Add a target university");
    fireEvent.change(input, { target: { value: "Stanford University" } });
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(8);
    expect(screen.queryByRole("button", { name: "Remove Stanford University" })).not.toBeInTheDocument();
    expect(input).toHaveValue("Stanford University");
    expect(JSON.parse(window.localStorage.getItem("cc_targets_jiyeon@school.edu"))).toEqual(eight);
    // The deadline creator reads the school's calendar with research on, then
    // posts the rows in bulk; neither happened. (The chat's own calendar read
    // of the list runs at sign-in without research.)
    const deadlineCalls = () => calls.filter((c) => (c.path.includes("/api/calendar/context") && /"research":true/.test(c.body || "")) || c.path.includes("/api/students/deadlines/bulk"));
    expect(deadlineCalls()).toEqual([]);

    // Removing one makes room, and the next add creates that school's deadlines.
    fireEvent.click(screen.getByRole("button", { name: "Remove Rice University" }));
    await waitFor(() => expect(screen.queryByTestId("target-cap-note")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("button", { name: "Remove Stanford University" })).toBeInTheDocument();
    await waitFor(() => expect(deadlineCalls().map((c) => c.path)).toEqual(["/api/calendar/context", "/api/students/deadlines/bulk"]));
    expect(deadlineCalls()[0].body).toContain("Stanford University");
  }, 40000);

  // fit-7: the values read answered 402 (budget) while the fit read was
  // computed; the card shows the read, says why the values are missing, and
  // double-checks the school the read is for.
  it("shows the College Fit read when the values lookup fails, with the values part marked unavailable", async () => {
    routeReply = (path, method, options, json) => {
      if (path.includes("/api/colleges/values") && method === "POST") return json({ error: "The monthly AI budget doesn't allow this lookup right now.", code: "budget_exceeded" }, 402);
      if (path.includes("/api/positioning/targets")) {
        return json({ targets: [{
          schoolName: "The University of Texas at Austin",
          overallPositioningLabel: "Competitive",
          labelKey: "competitive",
          finalPositioningScore: 52.1,
          admissibility: { academicReadinessScore: 74, summary: "academically plausible but not comfortable" },
          competitiveness: { majorCompetitivenessScore: 48 },
          fit: { institutionalPriorityFitScore: 60 },
          confidence: { evidenceConfidence: "Medium", evidenceConfidenceScore: 61 },
          scoreRanges: {},
          mainRedFlags: [],
          profileComparison: {
            tests: { policy: "test_considered_or_required", advice: "submit", used: { test: "act", score: 33, band: { low: 29, high: 34 }, position: "within" }, sections: [], alternatives: [] },
            gpa: { gpa: 3.9, average: 3.8, position: "within", basis: "average" },
            admitRate: { used: 0.29, basis: "overall", overall: 0.29, earlyDecision: null },
          },
        }] });
      }
      if (path.includes("/api/positioning/verify")) return json({ verdict: "consistent", checks: [] });
      return null;
    };
    await signIn();
    const search = screen.getByPlaceholderText(/e\.g\. UC Berkeley/);
    fireEvent.change(search, { target: { value: "UT Austin" } });
    fireEvent.keyDown(search, { key: "Enter" });
    const card = await screen.findByTestId("fit-card", {}, { timeout: 5000 });
    await waitFor(() => expect(card).toHaveTextContent("Competitive"));
    expect(card).toHaveTextContent("The University of Texas at Austin");
    expect(screen.getByTestId("profile-comparison")).toHaveTextContent("Admit rate: 29% of all applicants");
    expect(screen.getByTestId("fit-matrix-unavailable")).toHaveTextContent("This month's AI budget is used up");
    expect(screen.queryByText("The monthly AI budget doesn't allow this lookup right now.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "🔎 Double-check with the web" }));
    await waitFor(() => expect(calls.some((c) => c.path.includes("/api/positioning/verify"))).toBe(true));
    const verify = calls.find((c) => c.path.includes("/api/positioning/verify"));
    expect(JSON.parse(verify.body).schoolName).toBe("The University of Texas at Austin");
  }, 40000);

  // ui-8: "Clear cached college values" deleted every school's read for
  // every student. The sidebar now offers a re-read of the school on the
  // card, which posts that one school with force and says how it went.
  it("re-reads the school on the card instead of clearing every school's values", async () => {
    let valuesPosts = 0;
    routeReply = (path, method, options, json) => {
      if (path.includes("/api/colleges/values") && method === "POST") {
        valuesPosts += 1;
        const body = JSON.parse(options.body);
        if (body.force && valuesPosts > 2) return json({ error: "The AI provider request failed.", code: "provider_error" }, 502);
        return json({ displayName: "Rice University", values: [], fit: null });
      }
      if (path.includes("/api/positioning/targets")) return json({ targets: [] });
      return null;
    };
    await signIn();
    expect(screen.queryByRole("button", { name: /Re-read this school/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Clear cached college values/)).not.toBeInTheDocument();
    const search = screen.getByPlaceholderText(/e\.g\. UC Berkeley/);
    fireEvent.change(search, { target: { value: "Rice" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await screen.findByTestId("fit-card", {}, { timeout: 5000 });
    const reread = await screen.findByRole("button", { name: "↺ Re-read this school" });
    expect(reread).toHaveAttribute("title", "Read this school's official pages again instead of using the saved read. Uses your AI budget.");
    fireEvent.click(reread);
    expect(await screen.findByText("Re-read from the school's official pages.")).toBeInTheDocument();
    const forced = calls.filter((c) => c.path.includes("/api/colleges/values") && c.method === "POST").map((c) => JSON.parse(c.body));
    expect(forced[1]).toEqual({ collegeName: "Rice University", force: true });
    // A failed re-read keeps the card and says so.
    fireEvent.click(screen.getByRole("button", { name: "↺ Re-read this school" }));
    expect(await screen.findByText("The re-read didn't finish, so the saved read is still shown. Try again later.")).toBeInTheDocument();
    expect(screen.getByTestId("fit-card")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE" && c.path.includes("/api/colleges/values"))).toBe(false);
  }, 40000);

  it("shows only the localized error when neither read answered", async () => {
    routeReply = (path, method, options, json) => {
      if (path.includes("/api/colleges/values") && method === "POST") return json({ error: "Couldn't read any pages from elm.edu.", code: "no_official_pages" }, 404);
      if (path.includes("/api/positioning/targets")) return json({ error: "nothing" }, 500);
      return null;
    };
    await signIn();
    const search = screen.getByPlaceholderText(/e\.g\. UC Berkeley/);
    fireEvent.change(search, { target: { value: "Elm College" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(await screen.findByText("The school's official pages couldn't be read. Paste a specific official page URL above, such as its mission page, and look it up again.", {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path.includes("/api/positioning/targets"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("fit-card")).not.toBeInTheDocument();
  }, 40000);
});
