import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import App from "./App.jsx";
import { sessionTimer } from "./session/server-session.js";
import { buildVaultBlob, encrypt, storageKeyFor } from "./session/vault-storage.js";
import { baseFromData, vaultSyncRecord } from "./profile/profile-reconcile.js";

// The session boundary and the profile's sync with the server, walked
// through the real App with fetch stubbed by path (as AdminApp.test.jsx
// does). On a shared school or family computer the next student used to
// find the last one's draft, fit card, thread and typed passphrase; and a
// day-old device used to post its stale record over a newer one a second
// after the chat opened.
function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

const PASS = "correct-horse-battery";

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

describe("ending a session", () => {
  let calls;
  let routeReply;

  beforeEach(() => {
    calls = [];
    routeReply = null;
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      const body = typeof options.body === "string" ? JSON.parse(options.body) : null;
      calls.push({ method, path, body, headers: options.headers || {} });
      const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) });
      const routed = routeReply?.(path, method, body, json);
      if (routed) return routed;
      if (method === "POST" && path.includes("/api/students/register")) return json({ token: "tok_new_1", studentId: "stu_new_1", recoveryCode: "RCV-1234-ABCD" }, 201);
      if (method === "POST" && path.includes("/api/students/auth")) return json({ token: body.email.startsWith("a@") ? "tok_A" : "tok_B", studentId: "stu" });
      if (method === "POST" && path.includes("/api/consent/grant")) return json({ granted: true });
      if (path.includes("/api/consent/status")) return json({ consents: {}, missing: [] });
      if (path.includes("/api/students/budget")) return json({ grade: 11 });
      if (path.includes("/api/students/export")) return json({ profile: { name: "Jiyeon Kim" } });
      if (path.includes("/api/students/profile")) return json({ revision: "r2", profile: serverProfile, metrics: [], milestoneCount: 0 });
      if (path.includes("/api/students/sync")) return json({ synced: true, changes: [], setAside: [], revision: "r3" });
      if (path.includes("/api/students/logout")) return json({ loggedOut: true });
      if (/\/api\/students\/threads\/t1$/.test(path)) return json({ thread: { id: "t1", title: "Essay plan" }, messages: [{ role: "user", content: "Help me plan my essay about my grandmother" }] });
      if (path.includes("/api/students/threads")) return json({ threads: [{ id: "t1", title: "Essay plan", updated_at: "2026-09-01 10:00:00", message_count: 2 }] });
      return json({});
    }));
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; });

  async function signIn(email, { reveal = false } = {}) {
    await screen.findByText("Welcome back");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: PASS } });
    if (reveal) fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("E 35 · M 31 · R 34 · S 32", {}, { timeout: 15000 });
  }

  const composer = () => screen.getByPlaceholderText(/Ask about academics, ECs, colleges, or strategy/);
  const fitQuery = () => screen.getByPlaceholderText("e.g. UC Berkeley, Princeton, Texas A&M College Station");
  const expectEmptyLoginForm = () => {
    expect(screen.getByLabelText("Email")).toHaveValue("");
    expect(screen.getByLabelText("Passphrase")).toHaveValue("");
    // The Show toggle is off again, so nothing typed next is revealed.
    expect(screen.getByLabelText("Passphrase")).toHaveAttribute("type", "password");
  };

  it("logs out to an empty tree: no draft, no fit query, no open thread, no typed passphrase", async () => {
    render(<App />);
    await signIn("a@school.edu", { reveal: true });
    fireEvent.change(composer(), { target: { value: "My parents' income is 40,000 USD and my dad lost his job" } });
    fireEvent.change(fitQuery(), { target: { value: "MIT" } });
    fireEvent.click(await screen.findByText("Essay plan"));
    expect(await screen.findByText("Help me plan my essay about my grandmother")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Essay plan")).toHaveStyle({ fontWeight: "600" }));

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
    expectEmptyLoginForm();
    expect(window.__CC_SESSION_TOKEN__).toBeNull();
    const logout = calls.find((c) => c.method === "POST" && c.path.includes("/api/students/logout"));
    expect(logout.headers.Authorization).toBe("Bearer tok_A");

    await signIn("b@school.edu");
    expect(composer()).toHaveValue("");
    expect(fitQuery()).toHaveValue("");
    expect(screen.queryByText("Help me plan my essay about my grandmother")).not.toBeInTheDocument();
    // B has no thread open, so B's first message starts its own thread
    // instead of being appended to A's.
    expect(await screen.findByText("Essay plan")).toHaveStyle({ fontWeight: "400" });
  }, 60000);

  it("the inactivity expiry revokes the server session and leaves nothing to sign back in with", async () => {
    const reset = vi.spyOn(sessionTimer, "reset");
    render(<App />);
    await signIn("a@school.edu", { reveal: true });
    fireEvent.change(composer(), { target: { value: "a private question" } });
    const expire = reset.mock.calls.map((args) => args[0]).filter((fn) => typeof fn === "function").pop();
    expect(expire).toBeTypeOf("function");
    await act(async () => { expire(); });

    expect(await screen.findByText("Session expired due to inactivity. Please sign in again.")).toBeInTheDocument();
    expectEmptyLoginForm();
    expect(window.__CC_SESSION_TOKEN__).toBeNull();
    // The expiry used to revoke nothing: A's token stayed valid on the
    // server for its 7-day sliding lifetime.
    const logout = calls.find((c) => c.method === "POST" && c.path.includes("/api/students/logout"));
    expect(logout?.headers.Authorization).toBe("Bearer tok_A");

    // One click on Sign in used to open A's account again.
    const authCalls = calls.filter((c) => c.path.includes("/api/students/auth")).length;
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Email is required")).toBeInTheDocument();
    expect(calls.filter((c) => c.path.includes("/api/students/auth"))).toHaveLength(authCalls);
  }, 60000);

  it("deleting the account ends the session the same way and opens an empty account form", async () => {
    render(<App />);
    await signIn("a@school.edu");
    fireEvent.change(composer(), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Create your account")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE" && /\/api\/students$/.test(c.path))).toBe(true);
    expect(window.__CC_SESSION_TOKEN__).toBeNull();
    expect(screen.getByLabelText("School or organizational email")).toHaveValue("");
  }, 60000);

  it("a new account after the last student's session starts from a blank survey", async () => {
    const reset = vi.spyOn(sessionTimer, "reset");
    render(<App />);
    await signIn("a@school.edu");
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    expect(await screen.findByPlaceholderText("e.g. 3.75")).toHaveValue(3.9);
    const expire = reset.mock.calls.map((args) => args[0]).filter((fn) => typeof fn === "function").pop();
    await act(async () => { expire(); });
    await screen.findByText("Welcome back");

    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    fireEvent.change(await screen.findByLabelText("First name"), { target: { value: "Minseo" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Park" } });
    fireEvent.change(screen.getByLabelText("School or organizational email"), { target: { value: "minseo@school.edu" } });
    fireEvent.change(screen.getByLabelText(/^Passphrase/), { target: { value: "correct-horse-battery-staple" } });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: "correct-horse-battery-staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Junior" }));
    fireEvent.click(document.getElementById("ageAttest"));
    fireEvent.click(document.getElementById("consentAI"));
    fireEvent.click(document.getElementById("consentData"));
    fireEvent.click(screen.getByRole("button", { name: /^Create/ }));
    await screen.findByText(/Save your one-time account recovery code offline/, {}, { timeout: 15000 });
    // A's GPA used to be waiting in the new account's survey, and Finish
    // would have saved A's record as Minseo's.
    expect(screen.getByPlaceholderText("e.g. 3.75")).toHaveValue(null);
  }, 60000);
});

describe("joining a device's vault with the server's profile at sign-in", () => {
  let calls;
  let profileBody;
  let syncReplies;

  beforeEach(() => {
    calls = [];
    profileBody = { revision: "r2", profile: serverProfile };
    syncReplies = [];
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
      if (path.includes("/api/students/profile")) return json(profileBody);
      if (path.includes("/api/students/sync")) {
        const reply = syncReplies.shift();
        return reply ? reply(json) : json({ synced: true, changes: [], setAside: [], revision: "r9" });
      }
      if (path.includes("/api/students/threads")) return json({ threads: [] });
      return json({});
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; });

  async function seedVault(data, sync) {
    const email = "jiyeon@school.edu";
    const blob = buildVaultBlob(data, { name: "Jiyeon Kim", grade: "Junior" }, { sync });
    window.localStorage.setItem(await storageKeyFor(email), await encrypt(blob, PASS, email));
  }

  async function signIn() {
    render(<App />);
    await screen.findByText("Welcome back");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jiyeon@school.edu" } });
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: PASS } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("E 35 · M 31 · R 34 · S 32", {}, { timeout: 15000 });
  }

  const syncCalls = () => calls.filter((c) => c.method === "POST" && c.path.includes("/api/students/sync"));
  const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The day-old Chromebook: same course count, an older ACT, an activity
  // deleted on the other device. Written before sync bases existed.
  const staleVault = {
    profile: { ...serverProfile, testScores: [{ test: "act", totalScore: 30, sections: { english: 30, math: 30, reading: 30, science: 30 } }] },
    activities: [{ id: "old", name: "Quit club", role: "Member" }],
    goals: [],
    majorInterest: "Computer Science",
    surveyCompleted: true,
  };

  it("takes the newer server record over an old vault and sends nothing back", async () => {
    await seedVault(staleVault);
    await signIn();
    expect(screen.queryByText("E 30 · M 30 · R 30 · S 30")).not.toBeInTheDocument();
    expect(screen.queryByText("Quit club")).not.toBeInTheDocument();
    // Reaching the chat used to post the vault a second later.
    await idle(1600);
    expect(syncCalls()).toHaveLength(0);
  }, 40000);

  it("sends an edit made on this device after the profile read, against the server's revision", async () => {
    const base = baseFromData(staleVault, "r1");
    const edited = { ...staleVault, goals: ["Campus life"] };
    await seedVault(edited, vaultSyncRecord(edited, base));
    await signIn();
    await waitFor(() => expect(syncCalls()).toHaveLength(1), { timeout: 5000 });
    const profileRead = calls.findIndex((c) => c.path.includes("/api/students/profile"));
    const firstSync = calls.findIndex((c) => c.method === "POST" && c.path.includes("/api/students/sync"));
    expect(profileRead).toBeGreaterThanOrEqual(0);
    expect(firstSync).toBeGreaterThan(profileRead);
    const [sent] = syncCalls();
    expect(sent.body.baseRevision).toBe("r2");
    expect(sent.body.goals).toEqual(["Campus life"]);
    // Everything the device had not edited came from the server.
    expect(sent.body.profile.testScores[0].totalScore).toBe(33);
    expect(sent.body.activities).toEqual([]);
  }, 40000);

  it("opens the profile editor without inventing a grade, a course year or an exam year", async () => {
    profileBody = {
      revision: "r2",
      profile: {
        ...serverProfile,
        courses: [...serverProfile.courses, { name: "Chemistry Honors", type: "honors", grade: "", year: "junior" }, { name: "World History", type: "regular", grade: "B+" }],
        apScores: [{ exam: "US History", score: 5 }],
      },
    };
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    await screen.findByPlaceholderText("e.g. 3.75");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Add courses by school year")).toBeInTheDocument();
    // World History has no year: it waits under its own tab, not freshman.
    expect(screen.getByRole("button", { name: "Freshman (0)" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/1 course has no school year saved/);
    fireEvent.click(screen.getByRole("button", { name: "Junior (2)" }));
    expect(screen.getByText(/Chemistry Honors — No grade recorded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "AP exam scores (1)" }));
    expect(screen.getByText(/AP US History: 5 \(year not stated\)/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/AP US History has no exam year saved/);
  }, 40000);

  // The profile route answers { unweighted: null, weighted: null } for a
  // student with no GPA; adopted as is, it showed an empty GPA card and the
  // profile quick reply said "GPA: null".
  it("reads the server's no-GPA answer as no GPA on a new device", async () => {
    profileBody = { revision: "r2", profile: { ...serverProfile, gpa: { unweighted: null, weighted: null } } };
    await signIn();
    expect(screen.getByText(/Tell the agent your GPA\.|GPA not available yet\.|not entered/)).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/Ask about academics, ECs, colleges, or strategy/);
    fireEvent.change(box, { target: { value: "what's my gpa" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent(/GPA/), { timeout: 10000 });
    await waitFor(() => expect(screen.getByRole("log").textContent).toMatch(/I don't have a GPA saved yet|not (yet available|entered)/), { timeout: 10000 });
    expect(screen.getByRole("log").textContent).not.toMatch(/GPA: null/);
  }, 40000);

  it("answers a 409 by joining the other device's save, telling the student, and sending once more", async () => {
    const base = baseFromData(staleVault, "r1");
    const edited = { ...staleVault, goals: ["Campus life"] };
    await seedVault(edited, vaultSyncRecord(edited, base));
    syncReplies.push((json) => json({ code: "profile_revision_conflict", revision: "r5", profile: { ...serverProfile, majorInterest: "Physics" } }, 409));
    await signIn();
    expect(await screen.findByText(/Your profile changed on another device\./, {}, { timeout: 6000 })).toBeInTheDocument();
    await waitFor(() => expect(syncCalls()).toHaveLength(2), { timeout: 5000 });
    const second = syncCalls()[1].body;
    expect(second.baseRevision).toBe("r5");
    expect(second.goals).toEqual(["Campus life"]);
    expect(second.majorInterest).toBe("Physics");
  }, 40000);
});
