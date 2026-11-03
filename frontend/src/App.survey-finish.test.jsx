import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import App from "./App.jsx";
import { SURVEY_JOIN_FAILED, SURVEY_JOIN_REVIEW } from "./handlers/survey-handlers.js";
import { PROFILE_LOAD_FAILED } from "./handlers/auth-handlers.js";
import { buildVaultBlob, encrypt, storageKeyFor, storageApi } from "./session/vault-storage.js";

const EMAIL = "jiyeon@school.edu";
const PASS = "correct-horse-battery";

// Finishing the survey, walked through the real App with the blocking save
// on (__CC_PROXY_URL__ set): what Finish sends is what the student sees.
function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

const savedProfile = {
  gpa: { unweighted: 3.9, weighted: null },
  classRank: null,
  courses: [{ name: "Calculus BC", type: "ap", grade: "A", year: "junior", semester: "full_year" }],
  apScores: [],
  testScores: [{ test: "act", totalScore: 33, sections: { english: 35, math: 31, reading: 34, science: 32 } }],
  activities: [],
  majorInterest: "Computer Science",
  goals: ["Top 20"],
};

describe("finishing the survey", () => {
  let calls;
  let profileReply;
  // False while the backend cannot be reached: every request fails the way
  // fetch fails with no network.
  let serverUp;

  beforeEach(() => {
    calls = [];
    serverUp = true;
    profileReply = (json) => json({ revision: "r2", profile: savedProfile });
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("localStorage", memoryStorage());
    window.__CC_PROXY_URL__ = "/api/chat";
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      calls.push({ method, path, body: typeof options.body === "string" ? JSON.parse(options.body) : null });
      if (!serverUp) throw new TypeError("Failed to fetch");
      const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) });
      if (method === "POST" && path.includes("/api/students/auth")) return json({ token: "tok_test_1", studentId: "stu_test_1" });
      if (path.includes("/api/consent/status")) return json({ consents: {}, missing: [], revoked: [] });
      if (path.includes("/api/students/budget")) return json({ grade: 11 });
      if (path.includes("/api/students/export")) return json({ profile: { name: "Jiyeon Kim" } });
      if (path.includes("/api/students/profile")) return profileReply(json);
      if (path.includes("/api/students/sync")) return json({ synced: true, changes: [], setAside: [], revision: "r9" });
      if (path.includes("/api/students/threads")) return json({ threads: [] });
      return json({});
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; delete window.__CC_PROXY_URL__; });

  const surveySaves = () => calls.filter((c) => c.path.includes("/api/students/sync") && c.body?.trigger === "survey_complete");

  async function signIn() {
    render(<App />);
    await screen.findByText("Welcome back");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: EMAIL } });
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: PASS } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  }

  // Sign-in reads the saved profile, twice if the first read fails. When
  // both fail, a device with no finished survey of its own used to send a
  // returning student to an empty survey as if she were new; she now stays
  // on the sign-in screen, told why, with nothing saved and the session it
  // opened closed again. Signing in again once the server answers works.
  it("keeps the student on the sign-in screen when her saved profile can't be read", async () => {
    profileReply = (json) => json({ error: "Profile retrieval failed" }, 500);
    await signIn();
    expect(await screen.findByText(PROFILE_LOAD_FAILED["en-US"], {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. 3.75")).toBeNull();
    expect(calls.filter((c) => c.path.includes("/api/students/profile"))).toHaveLength(2);
    // Nothing was written: the only requests that were not reads opened the
    // session and closed it.
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual(["/api/students/auth", "/api/students/logout"]);
    expect(window.__CC_SESSION_TOKEN__).toBeNull();
    // The passphrase is still typed in, so trying again is one click.
    expect(screen.getByLabelText("Passphrase")).toHaveValue(PASS);

    profileReply = (json) => json({ revision: "r2", profile: savedProfile });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("E 35 · M 31 · R 34 · S 32", {}, { timeout: 15000 })).toBeInTheDocument();
    expect(surveySaves()).toEqual([]);
  }, 60000);

  // The one way left onto the survey without having read the server's
  // profile: a device that opened her vault while the backend was
  // unreachable. Its vault holds no finished survey, so she lands on the
  // survey offline. Finish used to post what she typed with no baseRevision
  // once the connection was back, and the server stored it over her real
  // courses and scores.
  it("never posts the survey blind over a profile this device has not seen", async () => {
    // An earlier visit left the passphrase verifier on this device and no
    // profile.
    await storageApi.set(await storageKeyFor(EMAIL), await encrypt(buildVaultBlob({}, { name: "Jiyeon Kim", grade: "Junior" }, { verifier: true }), PASS, EMAIL));
    serverUp = false;
    await signIn();
    fireEvent.change(await screen.findByPlaceholderText("e.g. 3.75", {}, { timeout: 15000 }), { target: { value: "3.5" } });
    // Sign-in could not read the profile at all.
    expect(calls.filter((c) => c.path.includes("/api/students/profile"))).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByPlaceholderText("Course name"), { target: { value: "Biology" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByText("I haven't taken standardized tests yet"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Large state school" }));

    // The connection is back, but the profile read fails: nothing is saved,
    // and the student hears why.
    serverUp = true;
    profileReply = (json) => json({ error: "Profile retrieval failed" }, 500);
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByText(SURVEY_JOIN_FAILED, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(calls.filter((c) => c.path.includes("/api/students/sync"))).toEqual([]);

    // The server answers now: her saved record is put in the form, from the
    // first step, instead of the survey going over it.
    profileReply = (json) => json({ revision: "r7", profile: savedProfile });
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByText(SURVEY_JOIN_REVIEW, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. 3.75")).toHaveValue(3.9);
    expect(calls.filter((c) => c.path.includes("/api/students/sync"))).toEqual([]);

    // Checked and finished, it is saved against the revision she was shown.
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(surveySaves()).toHaveLength(1), { timeout: 8000 });
    const [save] = surveySaves();
    expect(save.body.baseRevision).toBe("r7");
    expect(save.body.profile.courses.map((c) => c.name)).toEqual(["Calculus BC"]);
    expect(save.body.profile.testScores).toEqual(savedProfile.testScores);
  }, 60000);

  // Finish was a memoized callback whose hand-kept dependency list left out
  // the class rank: an edit to the rank alone was saved as the old rank, and
  // the fidelity check then held the counselor to it.
  it("saves a class rank edited on its own in the profile editor", async () => {
    await signIn();
    await screen.findByText("E 35 · M 31 · R 34 · S 32", {}, { timeout: 15000 });
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    await screen.findByPlaceholderText("e.g. 3.75");
    fireEvent.change(screen.getByLabelText("Class rank"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Class size"), { target: { value: "400" } });
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(surveySaves()).toHaveLength(1), { timeout: 8000 });
    const [save] = surveySaves();
    expect(save.body.profile.classRank).toEqual({ topPercent: 3, rank: 12, size: 400 });
    expect(save.body.baseRevision).toBe("r2");
  }, 60000);
});
