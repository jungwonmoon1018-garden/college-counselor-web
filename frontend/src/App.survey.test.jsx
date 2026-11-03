import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import App from "./App.jsx";

// The survey's transcript step, walked through the real App. The import used
// to key a course on its year and name, so the spring row of every
// semester-graded course was dropped as a "duplicate" of the fall row with
// its grade, and the course form did nothing at all for a full list or a
// repeated row.
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
  courses: [{ name: "Calculus BC", type: "ap", grade: "A", year: "junior", semester: "full_year" }],
  apScores: [],
  testScores: [{ test: "act", totalScore: 33, sections: { english: 35, math: 31, reading: 34, science: 32 } }],
  activities: [],
  majorInterest: "Computer Science",
  goals: [],
};

// What GET /api/consent/requirements describes: the onboarding three and,
// in this test, one more the server has started to require.
const requirements = [
  { consentType: "data_processing", required: true, label: "Data processing consent", description: "Storing what I enter." },
  { consentType: "ai_interaction", required: true, label: "External AI processing consent", description: "Redacted text goes to OpenRouter." },
  { consentType: "cross_border_transfer", required: true, label: "Cross-border transfer consent", description: "It may be processed abroad." },
  { consentType: "fafsa_contributor", required: true, label: "FAFSA contributor consent", description: "I may record a FAFSA contributor's details." },
];

describe("survey transcript step", () => {
  let calls;
  let profileBody;
  let importReply;

  beforeEach(() => {
    calls = [];
    profileBody = { revision: "r2", profile: serverProfile };
    importReply = null;
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      calls.push({ method, path, body: typeof options.body === "string" ? JSON.parse(options.body) : null });
      const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) });
      if (method === "POST" && path.includes("/api/students/auth")) return json({ token: "tok_test_1", studentId: "stu_test_1" });
      if (path.includes("/api/consent/status")) return json({ consents: {}, missing: [], revoked: [] });
      if (path.includes("/api/consent/requirements")) return json(requirements);
      if (method === "POST" && path.includes("/api/consent/grant")) return json({ granted: true });
      if (path.includes("/api/students/transcript-import")) return typeof importReply === "function" ? importReply(json) : json(importReply);
      if (path.includes("/api/students/budget")) return json({ grade: 11 });
      if (path.includes("/api/students/export")) return json({ profile: { name: "Jiyeon Kim" } });
      if (path.includes("/api/students/profile")) return json(profileBody);
      if (path.includes("/api/students/sync")) return json({ synced: true, changes: [], setAside: [], revision: "r3" });
      if (path.includes("/api/students/threads")) return json({ threads: [] });
      return json({});
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; });

  async function openTranscriptStep() {
    render(<App />);
    await screen.findByText("Welcome back");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jiyeon@school.edu" } });
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("E 35 · M 31 · R 34 · S 32", {}, { timeout: 15000 });
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    await screen.findByPlaceholderText("e.g. 3.75");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Add courses by school year")).toBeInTheDocument();
  }

  function attachTranscript() {
    const file = { name: "transcript.pdf", type: "application/pdf", size: 4, arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer };
    fireEvent.change(document.getElementById("transcriptImportInput"), { target: { files: [file] } });
  }

  it("imports both terms of a semester course and says which row was already on the list", async () => {
    importReply = {
      courses: {
        junior: [
          { name: "Chemistry Honors", type: "honors", grade: "A", semester: "fall" },
          { name: "Chemistry Honors", type: "honors", grade: "B+", semester: "spring" },
          { name: "Calculus BC", type: "ap", grade: "A", semester: "full_year" },
        ],
      },
    };
    await openTranscriptStep();
    attachTranscript();
    expect(await screen.findByText(/Imported 2 courses \(skipped: 1 already on your list\)\./, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/duplicates or over the/)).not.toBeInTheDocument();
    // Calculus BC, plus the fall and the spring Chemistry rows.
    expect(screen.getByRole("button", { name: "Junior (3)" })).toBeInTheDocument();
  }, 40000);

  // debt-11: a consent the app does not know was filtered out of the heal and
  // the student saw "Import failed". It is now asked for, in the server's own
  // words, and granted only when the student ticks it; a type the server does
  // not describe is named and never granted.
  it("asks for a consent the app does not know instead of failing or granting it", async () => {
    importReply = (json) => json({ error: "AI consent is required before transcript parsing.", code: "consent_required", missing: ["fafsa_contributor", "brand_new_consent"] }, 403);
    await openTranscriptStep();
    attachTranscript();
    const panel = await screen.findByTestId("consent-needed", {}, { timeout: 5000 });
    expect(screen.getByText("This needs a permission you haven't given yet.")).toBeInTheDocument();
    expect(await screen.findByText("FAFSA contributor consent")).toBeInTheDocument();
    expect(panel).toHaveTextContent("can't describe a required permission (brand_new_consent)");
    const grants = () => calls.filter((c) => c.method === "POST" && c.path.includes("/api/consent/grant"));
    // Nothing is granted on its own, and the button waits for the tick.
    expect(grants()).toEqual([]);
    const give = screen.getByRole("button", { name: "Give permission" });
    expect(give).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(give);
    await waitFor(() => expect(grants().map((c) => c.body.consentType)).toEqual(["fafsa_contributor"]));
    expect(grants()[0].body.grantedBy).toBe("student");
    await waitFor(() => expect(screen.queryByTestId("consent-needed")).not.toBeInTheDocument());
    expect(screen.getByText("Permission given. Try that again now.")).toBeInTheDocument();
  }, 40000);

  it("tells the student a repeated course and term is already on the list instead of doing nothing", async () => {
    await openTranscriptStep();
    fireEvent.click(screen.getByRole("button", { name: "Junior (1)" }));
    const name = screen.getByPlaceholderText("Course name");
    fireEvent.change(name, { target: { value: "calculus bc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("calculus bc (full-year) is already on the Junior tab. Double-click its chip to change it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Junior (1)" })).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes("/api/students/transcript-import"))).toBe(false);
  }, 40000);

  it("refuses a course past the 80-row limit and says why", async () => {
    const full = Array.from({ length: 80 }, (_, i) => ({ name: `Course ${i + 1}`, type: "regular", grade: "A", year: "senior", semester: "full_year" }));
    profileBody = { revision: "r2", profile: { ...serverProfile, courses: full } };
    await openTranscriptStep();
    fireEvent.change(screen.getByPlaceholderText("Course name"), { target: { value: "Orchestra" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Your course list holds 80 rows, the most it can. Remove one to add another.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Freshman (0)" })).toBeInTheDocument());
  }, 40000);
});
