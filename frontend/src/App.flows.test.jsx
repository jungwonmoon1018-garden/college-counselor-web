import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import App from "./App.jsx";

// The flows App() owns that no other test walks: creating an account into the
// survey, the target-school list, the chat threads and logging out. Written
// before App()'s state and callbacks moved into hooks (src/hooks/), so that a
// move which changes behaviour fails here first.
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
  apScores: [],
  testScores: [{ test: "act", totalScore: 33, sections: { english: 35, math: 31, reading: 34, science: 32 } }],
  activities: [],
  majorInterest: "Computer Science",
  goals: [],
};

describe("App flows", () => {
  let calls;
  let threads;

  beforeEach(() => {
    calls = [];
    threads = [{ id: "t1", title: "Essay plan", updated_at: "2026-09-01 10:00:00", message_count: 2 }];
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ method, path, body, headers: options.headers || {} });
      const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) });
      if (method === "POST" && path.includes("/api/students/register")) return json({ token: "tok_new_1", studentId: "stu_new_1", recoveryCode: "RCV-1234-ABCD" }, 201);
      if (method === "POST" && path.includes("/api/students/auth")) return json({ token: "tok_test_1", studentId: "stu_test_1" });
      if (method === "POST" && path.includes("/api/consent/grant")) return json({ granted: true });
      if (path.includes("/api/students/budget")) return json({ grade: 11 });
      if (path.includes("/api/students/export")) return json({ profile: { name: "Jiyeon Kim" } });
      if (path.includes("/api/students/profile")) return json({ profile: backendProfile, metrics: [], milestoneCount: 0 });
      if (path.includes("/api/students/sync")) return json({ synced: true, changesDetected: 0, changes: [] });
      if (path.includes("/api/students/logout")) return json({ ok: true });
      const thread = path.match(/\/api\/students\/threads\/([^/?]+)/);
      if (thread && method === "DELETE") { threads = threads.filter((t) => t.id !== thread[1]); return json({ ok: true }); }
      if (thread && method === "PATCH") { threads = threads.map((t) => (t.id === thread[1] ? { ...t, title: body.title } : t)); return json({ ok: true }); }
      if (path.includes("/api/students/threads") && method === "POST") {
        const created = { id: `t${threads.length + 1}`, title: body?.title || "New chat", updated_at: "2026-09-21 09:00:00", message_count: 0 };
        threads = [created, ...threads];
        return json({ id: created.id });
      }
      if (path.includes("/api/students/threads")) return json({ threads });
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

  it("creates an account, grants the three consents, shows the recovery code and walks into the survey", async () => {
    render(<App />);
    await screen.findByText("Welcome back");
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    fireEvent.change(await screen.findByLabelText("First name"), { target: { value: "Minseo" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Park" } });
    fireEvent.change(screen.getByLabelText("School or organizational email"), { target: { value: "minseo@school.edu" } });
    fireEvent.change(screen.getByLabelText(/^Passphrase/), { target: { value: "correct-horse-battery-staple" } });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: "correct-horse-battery-staple" } });
    const submit = screen.getByRole("button", { name: /^Create/ });
    // The grade is required: the form names what is missing instead of sending.
    fireEvent.click(submit);
    expect(await screen.findByText("Select your grade")).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes("/api/students/register"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Junior" }));
    fireEvent.click(document.getElementById("ageAttest"));
    fireEvent.click(document.getElementById("consentAI"));
    fireEvent.click(document.getElementById("consentData"));
    fireEvent.click(submit);

    expect(await screen.findByText(/Save your one-time account recovery code offline/, {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByText(/RCV-1234-ABCD/)).toBeInTheDocument();
    const register = calls.find((c) => c.path.includes("/api/students/register"));
    expect(register.body.email).toBe("minseo@school.edu");
    await waitFor(() => {
      const granted = calls.filter((c) => c.path.includes("/api/consent/grant")).map((c) => c.body.consentType).sort();
      expect(granted).toEqual(["ai_interaction", "cross_border_transfer", "data_processing"]);
    }, { timeout: 5000 });

    // The survey's own state: a GPA moves the student on to the transcript step.
    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. 3.75"), { target: { value: "3.8" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Add courses by school year")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByPlaceholderText("e.g. 3.75")).toHaveValue(3.8);
  }, 40000);

  it("adds and removes a target school and keeps the list per account on the device", async () => {
    await signIn();
    const input = screen.getByLabelText("Add a target university");
    fireEvent.change(input, { target: { value: "Rice University" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "Remove Rice University" })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("cc_targets_jiyeon@school.edu"))).toEqual(["Rice University"]);
    expect(input).toHaveValue("");
    // The same school again, in another case, is not a second entry.
    fireEvent.change(input, { target: { value: "rice university" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove Rice University" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Rice University" })).not.toBeInTheDocument());
    expect(JSON.parse(window.localStorage.getItem("cc_targets_jiyeon@school.edu"))).toEqual([]);
  }, 40000);

  it("lists the chat threads, starts a new one, renames it and deletes it", async () => {
    await signIn();
    expect(await screen.findByText("Essay plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ New" }));
    expect(await screen.findByText("New chat")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && /\/api\/students\/threads$/.test(c.path))).toBe(true);

    fireEvent.doubleClick(screen.getByText("New chat"));
    const box = screen.getByDisplayValue("New chat");
    fireEvent.change(box, { target: { value: "Senior year plan" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Senior year plan")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.body?.title === "Senior year plan")).toBe(true));

    const row = screen.getByText("Essay plan").closest("div").parentElement.parentElement;
    fireEvent.click(within(row).getByRole("button"));
    await waitFor(() => expect(screen.queryByText("Essay plan")).not.toBeInTheDocument(), { timeout: 5000 });
    expect(calls.some((c) => c.method === "DELETE" && c.path.includes("/api/students/threads/t1?hard=1"))).toBe(true);
    expect(screen.getByText("Senior year plan")).toBeInTheDocument();
  }, 40000);

  it("logs out to the login screen and drops the session", async () => {
    await signIn();
    expect(window.__CC_SESSION_TOKEN__).toBe("tok_test_1");
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
    expect(window.__CC_SESSION_TOKEN__).toBeNull();
    expect(calls.some((c) => c.method === "POST" && c.path.includes("/api/students/logout"))).toBe(true);
    expect(screen.queryByText("E 35 · M 31 · R 34 · S 32")).not.toBeInTheDocument();
  }, 40000);
});
