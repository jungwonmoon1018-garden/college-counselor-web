import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import App from "./App.jsx";
import { planningCycleStartYear, typicalDeadlineDates } from "./profile/admissions-cycle.js";

// Target-school reminders, walked through the real App. Adding a school made
// its reminders out of sight (nothing said what was added or skipped, and the
// chat-top chip kept its old count), and a school whose reminders belonged
// to an earlier cycle never got the dates of the cycle the student applies in.
function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

const serverProfile = {
  gpa: { unweighted: 3.9, weighted: null },
  classRank: null,
  courses: [{ name: "Calculus BC", type: "ap", grade: "A", year: "junior" }],
  apScores: [],
  testScores: [{ test: "act", totalScore: 33, sections: { english: 35, math: 31, reading: 34, science: 32 } }],
  activities: [],
  majorInterest: "Computer Science",
  goals: [],
};

// The student applies in the cycle after the one being planned now, so every
// round of hers is still ahead whatever day the suite runs.
const OWN = planningCycleStartYear(new Date()) + 1;
const OLD = OWN - 2;

describe("target-school reminders", () => {
  let calls;
  let listRows;
  let bulkReply;

  beforeEach(() => {
    calls = [];
    listRows = [];
    bulkReply = { ok: true, createdCount: 4, skipped: 1, skippedItems: [{ title: "x", reason: "duplicate" }] };
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      const body = typeof options.body === "string" ? JSON.parse(options.body) : null;
      calls.push({ method, path, body });
      const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) });
      if (method === "POST" && path.includes("/api/students/auth")) return json({ token: "tok_test_1", studentId: "stu_test_1" });
      if (path.includes("/api/consent/status")) return json({ consents: {}, missing: [] });
      if (path.includes("/api/students/budget")) return json({ grade: 11 });
      if (path.includes("/api/students/export")) return json({ profile: { name: "Jiyeon Kim" } });
      if (path.includes("/api/students/profile")) return json({ revision: "r2", profile: serverProfile });
      if (path.includes("/api/students/sync")) return json({ synced: true, changes: [], setAside: [], revision: "r3" });
      if (path.includes("/api/students/threads")) return json({ threads: [] });
      if (path.includes("/api/calendar/context")) {
        const schools = (body?.targetSchools || []).map((school) => ({ school, source: "typical", deadlines: {} }));
        return json({
          ok: true,
          calendar: { typicalISO: typicalDeadlineDates(OWN - 1) },
          studentCycle: { cycle: `${OWN}-${String((OWN + 1) % 100).padStart(2, "0")}`, startYear: OWN, entryYear: OWN + 1, classOf: OWN + 1, projected: true, typicalISO: typicalDeadlineDates(OWN) },
          schools,
          targetSchools: body?.targetSchools || [],
        });
      }
      if (method === "POST" && path.includes("/api/students/deadlines/bulk")) return json(bulkReply, 201);
      if (path.startsWith("/api/students/deadlines")) return json({ ok: true, deadlines: listRows, summary: { overdue: 0, dueIn7: 0, dueIn30: 0, upcoming: 0 } });
      return json({});
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; });

  async function signIn() {
    render(<App />);
    await screen.findByText("Welcome back");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jiyeon@school.edu" } });
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("E 35 · M 31 · R 34 · S 32", {}, { timeout: 15000 });
  }

  const bulkPosts = () => calls.filter((c) => c.method === "POST" && c.path.includes("/api/students/deadlines/bulk"));
  const listReads = () => calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/students/deadlines"));

  it("says what adding a school added and skipped, and the chip reads the list again", async () => {
    await signIn();
    const before = listReads().length;
    const input = screen.getByLabelText("Add a target university");
    fireEvent.change(input, { target: { value: "Rice University" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(`Rice University: added 4 deadlines for Fall ${OWN + 1} entry to your Deadlines list. 1 was already on your list.`, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(bulkPosts()).toHaveLength(1);
    expect(bulkPosts()[0].body.items.every((item) => item.title.includes(`for Fall ${OWN + 1} entry`))).toBe(true);
    await waitFor(() => expect(listReads().length).toBeGreaterThan(before));
    // Every list read is counted on the student's own calendar.
    expect(listReads().every((c) => /[?&]today=\d{4}-\d{2}-\d{2}/.test(c.path))).toBe(true);
  }, 40000);

  it("makes a school's reminders again for the student's cycle when all it has are an earlier cycle's", async () => {
    window.localStorage.setItem("cc_targets_jiyeon@school.edu", JSON.stringify(["Harvard University", "Rice University"]));
    listRows = [
      { id: "h1", title: "Harvard University — Early (EA/ED) (approximate — verify)", dueAt: `${OLD}-11-01`, dueDate: `${OLD}-11-01`, status: "open" },
      { id: "h2", title: "Harvard University — Regular Decision (approximate — verify)", dueAt: `${OLD + 1}-01-01`, dueDate: `${OLD + 1}-01-01`, status: "done" },
      { id: "r1", title: `Rice University — Regular Decision (approximate — for Fall ${OWN + 1} entry)`, dueAt: `${OWN + 1}-01-01`, dueDate: `${OWN + 1}-01-01`, status: "open" },
    ];
    bulkReply = { ok: true, createdCount: 4, skipped: 0, skippedItems: [] };
    await signIn();
    expect(await screen.findByText(`Harvard University: added 4 deadlines for Fall ${OWN + 1} entry to your Deadlines list.`, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(bulkPosts()).toHaveLength(1);
    expect(bulkPosts()[0].body.items[0].title.startsWith("Harvard University — ")).toBe(true);
    // Rice already has its rows for this cycle, and nothing is made twice.
    await new Promise((r) => setTimeout(r, 300));
    expect(bulkPosts()).toHaveLength(1);
    const research = calls.filter((c) => c.path.includes("/api/calendar/context") && c.body?.research === true);
    expect(research.map((c) => c.body.targetSchools)).toEqual([["Harvard University"]]);
  }, 40000);
});
