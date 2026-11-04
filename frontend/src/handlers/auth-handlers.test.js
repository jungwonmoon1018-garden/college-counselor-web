import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { handleLogin } from "./auth-handlers.js";
import { S } from "../app-shared.js";
import { buildVaultBlob, encrypt, storageKeyFor, storageApi } from "../session/vault-storage.js";

// Sign-in reads the server's profile before the student enters. When that
// one read failed (a 500, a 429, a cold start), a returning student on a new
// device was routed to an empty survey as if new, and what she typed there
// was the copy the app then tried to save. Finish now joins the server's
// profile first, but the empty survey itself misled her into retyping: the
// read is tried again once, and if it still fails she stays on the sign-in
// screen and is told why.
const EMAIL = "jiyeon@school.edu";
const PASS = "correct-horse-battery";
const FAILED_EN = "Couldn't load your saved profile. Try signing in again.";
const FAILED_KO = "저장된 프로필을 불러오지 못했습니다. 다시 로그인해 주세요.";

const savedProfile = {
  gpa: { unweighted: 3.9, weighted: null },
  classRank: null,
  courses: [{ name: "Calculus BC", type: "ap", grade: "A", year: "junior", semester: "full_year" }],
  apScores: [],
  testScores: [{ test: "act", totalScore: 33 }],
  activities: [{ id: "a1", name: "Robotics Club", role: "Captain", category: "stem" }],
  majorInterest: "Computer Science",
  goals: ["Top 20"],
};

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

function loginCtx(overrides = {}) {
  return {
    lEmail: EMAIL,
    lPass: PASS,
    loginAttempts: {},
    setData: vi.fn(),
    setLError: vi.fn(),
    setLoginAttempts: vi.fn(),
    setMessages: vi.fn(),
    setOfflineMode: vi.fn(),
    setPassphrase: vi.fn(),
    setScreen: vi.fn(),
    setSurveyStep: vi.fn(),
    setUser: vi.fn(),
    setLPass: vi.fn(),
    setShowLoginPass: vi.fn(),
    setSyncBase: vi.fn(),
    setProfileReady: vi.fn(),
    setSyncNote: vi.fn(),
    setSyncStatus: vi.fn(),
    ...overrides,
  };
}

describe("signing in when the saved profile can't be read", () => {
  let calls;
  let profileReplies;

  beforeEach(() => {
    calls = [];
    profileReplies = [];
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("localStorage", memoryStorage());
    window.__CC_SESSION_TOKEN__ = null;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      calls.push({ method, path, authorization: options.headers?.Authorization || null });
      const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
      if (method === "POST" && path === "/api/students/auth") return json({ token: "tok_test_1", studentId: "stu_test_1" });
      if (path === "/api/consent/status") return json({ missing: [], revoked: [] });
      if (path === "/api/students/budget") return json({ grade: 11 });
      if (path === "/api/students/export") return json({ profile: { name: "Jiyeon Kim" } });
      if (method === "POST" && path === "/api/students/logout") return json({ ok: true });
      if (path === "/api/students/profile") {
        const reply = profileReplies.length > 1 ? profileReplies.shift() : profileReplies[0];
        return reply(json);
      }
      return json({ error: "unexpected" }, 404);
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; });

  const profileReads = () => calls.filter((c) => c.path === "/api/students/profile");
  const saves = () => calls.filter((c) => c.path.includes("/api/students/sync"));
  const fail500 = (json) => json({ error: "Profile retrieval failed" }, 500);
  const failNetwork = () => { throw new TypeError("Failed to fetch"); };
  const answer = (profile) => (json) => json({ revision: "r7", profile });

  it("tries the read again once, then keeps a new device on the sign-in screen and says why", async () => {
    profileReplies = [fail500];
    const ctx = loginCtx();
    await handleLogin(ctx);
    expect(profileReads()).toHaveLength(2);
    expect(ctx.setLError).toHaveBeenLastCalledWith(FAILED_EN);
    // Not routed to the survey as if new, and not signed in at all.
    expect(ctx.setScreen).not.toHaveBeenCalled();
    expect(ctx.setSurveyStep).not.toHaveBeenCalled();
    expect(ctx.setUser).not.toHaveBeenCalled();
    expect(ctx.setPassphrase).not.toHaveBeenCalled();
    expect(ctx.setProfileReady).not.toHaveBeenCalledWith(true);
    // The passphrase stays typed in, so trying again is one click.
    expect(ctx.setLPass).not.toHaveBeenCalled();
    expect(saves()).toEqual([]);
    // The server session it opened is closed again.
    expect(window.__CC_SESSION_TOKEN__).toBeNull();
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/students/logout")).toEqual([
      { method: "POST", path: "/api/students/logout", authorization: "Bearer tok_test_1" },
    ]);
  });

  it("does the same when the read throws twice", async () => {
    profileReplies = [failNetwork];
    const ctx = loginCtx();
    await handleLogin(ctx);
    expect(profileReads()).toHaveLength(2);
    expect(ctx.setLError).toHaveBeenLastCalledWith(FAILED_EN);
    expect(ctx.setScreen).not.toHaveBeenCalled();
    expect(saves()).toEqual([]);
  });

  it("says it in Korean in a Korean session", async () => {
    localStorage.setItem("cc_locale", "ko");
    profileReplies = [fail500];
    const ctx = loginCtx();
    await handleLogin(ctx);
    expect(ctx.setLError).toHaveBeenLastCalledWith(FAILED_KO);
    expect(ctx.setScreen).not.toHaveBeenCalled();
  });

  it("signs the student in with her saved profile when the second read answers", async () => {
    profileReplies = [failNetwork, answer(savedProfile)];
    const ctx = loginCtx();
    await handleLogin(ctx);
    expect(profileReads()).toHaveLength(2);
    expect(ctx.setLError).not.toHaveBeenCalledWith(FAILED_EN);
    expect(ctx.setProfileReady).toHaveBeenCalledWith(true);
    const restored = ctx.setData.mock.calls.at(-1)[0];
    expect(restored.profile.courses.map((c) => c.name)).toEqual(["Calculus BC"]);
    expect(ctx.setScreen).toHaveBeenLastCalledWith(S.CHAT);
    expect(window.__CC_SESSION_TOKEN__).toBe("tok_test_1");
  });

  // A read that answers "no profile yet" is not a failure: a student who
  // never finished the survey anywhere still goes to it, after one read.
  it("sends a student with nothing saved to the survey after one read", async () => {
    profileReplies = [(json) => json({ profile: null })];
    const ctx = loginCtx();
    await handleLogin(ctx);
    expect(profileReads()).toHaveLength(1);
    expect(ctx.setLError).not.toHaveBeenCalledWith(FAILED_EN);
    expect(ctx.setScreen).toHaveBeenLastCalledWith(S.SURVEY);
  });

  // A device that finished the survey opens the chat on its own copy, as
  // before: nothing there is empty, the auto-save waits for the join, and
  // the chat retries the join until the server answers.
  it("still opens the chat on a device whose survey is complete", async () => {
    const local = { profile: { ...savedProfile, gpa: { unweighted: 3.8, weighted: null } }, surveyCompleted: true };
    await storageApi.set(await storageKeyFor(EMAIL), await encrypt(buildVaultBlob(local, { name: "Jiyeon Kim", grade: "Junior" }), PASS, EMAIL));
    profileReplies = [fail500];
    const ctx = loginCtx();
    await handleLogin(ctx);
    expect(profileReads()).toHaveLength(2);
    expect(ctx.setLError).not.toHaveBeenCalledWith(FAILED_EN);
    expect(ctx.setScreen).toHaveBeenLastCalledWith(S.CHAT);
    expect(ctx.setProfileReady).not.toHaveBeenCalledWith(true);
    expect(saves()).toEqual([]);
  });
});
