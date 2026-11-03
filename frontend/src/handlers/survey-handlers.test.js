import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSurveyComplete, hydrateSurveyFromCurrentData, reconcileWithBackendProfile, UNPLACED_YEAR } from "./survey-handlers.js";
import { S } from "../app-shared.js";
import { baseFromData } from "../profile/profile-reconcile.js";

// Finishing the survey saves the profile before the chat opens. authedFetch
// resolves on every HTTP status, and a refused save (413, 429, 500, 503)
// used to pass as saved: "your profile is saved and synced" over a counselor
// that had nothing.
function surveyCtx(overrides = {}) {
  return {
    authedFetch: vi.fn(),
    messages: [],
    sAPScores: [],
    sClassRank: { rank: "", size: "", topPercent: "" },
    sCourses: { freshman: [], sophomore: [], junior: [{ name: "Chemistry", type: "honors", grade: "A", semester: "full_year" }], senior: [] },
    sECs: [],
    sGoals: ["Explore options"],
    sGpaUw: "3.8",
    sGpaW: "",
    sMajorInterest: "Biology",
    sNoGpaYet: false,
    sNoTestsYet: true,
    sTests: [],
    setData: vi.fn(),
    setMessages: vi.fn(),
    setScreen: vi.fn(),
    setSurveyError: vi.fn(),
    user: null,
    // This device has joined the server's profile (sign-in read it); the
    // cases where it has not are below.
    profileReady: true,
    ...overrides,
  };
}

describe("finishing the survey", () => {
  beforeEach(() => { window.__CC_PROXY_URL__ = "/api/chat"; });
  afterEach(() => { delete window.__CC_PROXY_URL__; });

  it("stays on the survey and says why when the server refuses the save", async () => {
    const ctx = surveyCtx({ authedFetch: vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) });
    await handleSurveyComplete(ctx);
    expect(ctx.setSurveyError).toHaveBeenCalledWith("Too many saves in a row — wait a minute, then try again.");
    expect(ctx.setScreen).not.toHaveBeenCalled();
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });

  it("stays on the survey when the connection fails", async () => {
    const ctx = surveyCtx({ authedFetch: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
    await handleSurveyComplete(ctx);
    expect(ctx.setSurveyError).toHaveBeenCalledWith("Couldn't save your profile to your counselor — check your connection and try again.");
    expect(ctx.setScreen).not.toHaveBeenCalled();
  });

  it("opens the chat when the save lands, and names anything the server set aside", async () => {
    const ctx = surveyCtx({
      authedFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ synced: true, setAside: [{ field: "gpa.weighted", reason: "out_of_range" }] }) })),
    });
    await handleSurveyComplete(ctx);
    expect(ctx.setSurveyError).not.toHaveBeenCalled();
    expect(ctx.setScreen).toHaveBeenCalledWith(S.CHAT);
    const [welcome] = ctx.setMessages.mock.calls[0][0];
    expect(welcome.content).toContain("your profile is saved and synced.\n\nSaved, except your weighted GPA, which couldn't be read — check it in your profile.");
    const body = JSON.parse(ctx.authedFetch.mock.calls[0][1].body);
    expect(body.profile.gpa).toEqual({ unweighted: 3.8 });
  });

  it("says nothing extra when everything was saved", async () => {
    const ctx = surveyCtx({ authedFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ synced: true, setAside: [] }) })) });
    await handleSurveyComplete(ctx);
    const [welcome] = ctx.setMessages.mock.calls[0][0];
    expect(welcome.content).not.toContain("Saved, except");
  });
});

// Sign-in reads the server's profile once. When that read failed (a 500, a
// 429, a cold start), a returning student on a new device was shown an empty
// survey as if new, and Finish posted what she typed with no baseRevision;
// the server checks revisions only when one is sent, so her real courses,
// scores and activities were replaced in the snapshot the counselor, the
// fidelity check and College Fit read.
describe("finishing the survey before this device has seen the server's profile", () => {
  beforeEach(() => { window.__CC_PROXY_URL__ = "/api/chat"; });
  afterEach(() => { delete window.__CC_PROXY_URL__; });

  const saved = {
    gpa: { unweighted: 3.9, weighted: 4.4 },
    courses: [{ name: "Calculus BC", type: "ap", grade: "A", year: "junior", semester: "full_year" }],
    apScores: [{ exam: "Biology", score: 5, year: 2025 }],
    testScores: [{ test: "sat", totalScore: 1500 }],
    activities: [{ id: "a1", name: "Robotics", role: "Captain" }],
    goals: ["STEM-focused"],
    majorInterest: "Engineering",
  };

  // The routes the handler calls, answered by path; every call is kept.
  function server(profileReply) {
    const calls = [];
    const authedFetch = vi.fn(async (path, opts = {}) => {
      calls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
      if (path === "/api/students/profile") return profileReply();
      if (path === "/api/students/sync") return { ok: true, status: 200, json: async () => ({ synced: true, setAside: [], revision: "r8" }) };
      throw new Error(`unexpected ${path}`);
    });
    return { calls, authedFetch, syncs: () => calls.filter((c) => c.path === "/api/students/sync") };
  }

  function unjoinedCtx(authedFetch, overrides = {}) {
    let base = null;
    let data = { profile: null, activities: [], studyNotes: [], documents: [] };
    const ctx = surveyCtx({
      authedFetch,
      profileReady: false,
      getSyncBase: () => base,
      setSyncBase: vi.fn((next) => { base = next; }),
      setProfileReady: vi.fn(),
      setData: vi.fn((next) => { data = typeof next === "function" ? next(data) : next; }),
      hydrateSurveyFromCurrentData: vi.fn(),
      setSurveyStep: vi.fn(),
      ...overrides,
    });
    return { ctx, data: () => data, base: () => base };
  }

  it("saves nothing while the saved profile can't be read", async () => {
    for (const reply of [
      () => ({ ok: false, status: 500, json: async () => ({ error: "Profile retrieval failed" }) }),
      () => { throw new TypeError("Failed to fetch"); },
    ]) {
      const { calls, authedFetch, syncs } = server(reply);
      const { ctx } = unjoinedCtx(authedFetch);
      await handleSurveyComplete(ctx);
      expect(calls.map((c) => c.path)).toEqual(["/api/students/profile"]);
      expect(syncs()).toEqual([]);
      expect(ctx.setSurveyError).toHaveBeenCalledWith("Couldn't check this against the profile you may have saved before, so nothing was saved yet — check your connection and press Finish setup again.");
      expect(ctx.setData).not.toHaveBeenCalled();
      expect(ctx.setProfileReady).not.toHaveBeenCalled();
      expect(ctx.setScreen).not.toHaveBeenCalled();
    }
  });

  it("loads a saved profile into the form for the student to check instead of posting over it", async () => {
    const { authedFetch, syncs } = server(() => ({ ok: true, status: 200, json: async () => ({ revision: "r7", profile: saved }) }));
    const { ctx, data, base } = unjoinedCtx(authedFetch);
    await handleSurveyComplete(ctx);
    expect(syncs()).toEqual([]);
    expect(ctx.setScreen).not.toHaveBeenCalled();
    // The form shows the saved record, from the first step.
    const shown = ctx.hydrateSurveyFromCurrentData.mock.calls[0][0];
    expect(shown.profile.courses).toEqual(saved.courses);
    expect(shown.profile.testScores).toEqual(saved.testScores);
    expect(shown.activities).toEqual(saved.activities);
    expect(ctx.setSurveyStep).toHaveBeenCalledWith(0);
    expect(ctx.setSurveyError).toHaveBeenLastCalledWith("We found the profile you saved before and loaded it here, so nothing was saved over it. Check each step, then press Finish setup to save.");
    // The device has now joined: the next Finish is checked against r7.
    expect(base().serverRevision).toBe("r7");
    expect(ctx.setProfileReady).toHaveBeenCalledWith(true);
    expect(data().profile.courses).toEqual(saved.courses);
    expect(data().surveyCompleted).toBeUndefined();
  });

  it("saves against the server's revision once it has seen the server's profile", async () => {
    const same = {
      gpa: { unweighted: 3.8 },
      courses: [{ name: "Chemistry", type: "honors", grade: "A", semester: "full_year", year: "junior" }],
      apScores: [], testScores: [], testingStatus: "planned", activities: [], goals: ["Explore options"], majorInterest: "Biology",
    };
    const { authedFetch, syncs } = server(() => ({ ok: true, status: 200, json: async () => ({ revision: "r7", profile: same }) }));
    const { ctx } = unjoinedCtx(authedFetch);
    await handleSurveyComplete(ctx);
    expect(syncs()).toHaveLength(1);
    expect(syncs()[0].body.baseRevision).toBe("r7");
    expect(ctx.hydrateSurveyFromCurrentData).not.toHaveBeenCalled();
    expect(ctx.setScreen).toHaveBeenCalledWith(S.CHAT);
  });

  it("saves the survey when the server holds no profile yet", async () => {
    const { calls, authedFetch, syncs } = server(() => ({ ok: true, status: 200, json: async () => ({ profile: null, revision: null }) }));
    const { ctx } = unjoinedCtx(authedFetch);
    await handleSurveyComplete(ctx);
    expect(calls.map((c) => c.path)).toEqual(["/api/students/profile", "/api/students/sync"]);
    expect(syncs()[0].body.profile.courses.map((c) => c.name)).toEqual(["Chemistry"]);
    expect(ctx.setProfileReady).toHaveBeenCalledWith(true);
    expect(ctx.setScreen).toHaveBeenCalledWith(S.CHAT);
  });

  it("reads nothing first on a device that has joined", async () => {
    const { calls, authedFetch } = server(() => { throw new Error("no read expected"); });
    const ctx = surveyCtx({ authedFetch, getSyncBase: () => ({ serverRevision: "r3", snapshot: null }), setSyncBase: vi.fn() });
    await handleSurveyComplete(ctx);
    expect(calls.map((c) => c.path)).toEqual(["/api/students/sync"]);
    expect(calls[0].body.baseRevision).toBe("r3");
  });
});

// Opening "Edit profile" and pressing Finish must save the record the
// student has, not one the editor filled in: a blank grade used to become
// an A, a year-less AP exam this calendar year, a course with no year a
// freshman course, and an activity with no category the legacy "club".
function hydrateInto(source) {
  const state = {};
  const setter = (key) => (value) => { state[key] = typeof value === "function" ? value(state[key]) : value; };
  hydrateSurveyFromCurrentData({
    data: source,
    setSAPInput: setter("sAPInput"), setSAPScores: setter("sAPScores"), setSClassRank: setter("sClassRank"),
    setSCourseInput: setter("sCourseInput"), setSCourseYear: setter("sCourseYear"), setSCourses: setter("sCourses"),
    setSECInput: setter("sECInput"), setSECs: setter("sECs"), setSGoals: setter("sGoals"),
    setSGpaUw: setter("sGpaUw"), setSGpaW: setter("sGpaW"), setSNoGpaYet: setter("sNoGpaYet"),
    setSNoTestsYet: setter("sNoTestsYet"), setSTestCategory: setter("sTestCategory"), setSTestInput: setter("sTestInput"),
    setSTests: setter("sTests"), setSurveyError: setter("surveyError"), setsMajorInterest: setter("sMajorInterest"),
  });
  return state;
}

async function roundTrip(stored) {
  const state = hydrateInto(stored);
  const ctx = surveyCtx({
    ...state,
    messages: [{ role: "assistant", content: "hi" }, { role: "user", content: "edit" }],
    authedFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ synced: true, setAside: [], revision: "r9" }) })),
    setSyncBase: vi.fn(),
    getSyncBase: () => ({ serverRevision: "r8", snapshot: null }),
  });
  await handleSurveyComplete(ctx);
  return { state, ctx, body: JSON.parse(ctx.authedFetch.mock.calls[0][1].body) };
}

describe("the profile editor keeps unknowns unknown", () => {
  beforeEach(() => { window.__CC_PROXY_URL__ = "/api/chat"; });
  afterEach(() => { delete window.__CC_PROXY_URL__; });

  const stored = {
    profile: {
      gpa: { unweighted: 3.7, weighted: null },
      courses: [
        { name: "Chemistry Honors", type: "honors", grade: "", year: "junior", semester: "full_year" },
        { name: "World History", type: "regular", grade: "B+" },
        { name: "Seminar", type: "regular", grade: "A", year: "2024-25" },
      ],
      apScores: [{ exam: "US History", score: 5 }, { exam: "Biology", score: 4, year: 2025 }],
      testScores: [],
    },
    activities: [{ id: "act-1", name: "Robotics", role: "Captain", hoursPerWeek: 6 }],
    goals: ["STEM-focused"],
    majorInterest: "Engineering",
  };

  it("shows a blank grade, a missing year and a missing category as missing", () => {
    const state = hydrateInto(stored);
    expect(state.sCourses.junior[0].grade).toBe("");
    expect(state.sCourses.freshman).toEqual([]);
    expect(state.sCourses[UNPLACED_YEAR].map((c) => c.name)).toEqual(["World History", "Seminar"]);
    expect(state.sAPScores[0]).toEqual({ subject: "US History", score: "5", year: "" });
    expect(state.sECs[0].category).toBe("");
    expect(state.sECs[0].timing).toBe("");
  });

  it("saves them as missing on Finish, and sends the base revision", async () => {
    const { body, ctx } = await roundTrip(stored);
    const courses = Object.fromEntries(body.profile.courses.map((c) => [c.name, c]));
    expect(courses["Chemistry Honors"].grade).toBe("");
    expect(courses["Chemistry Honors"].year).toBe("junior");
    expect(courses["World History"]).not.toHaveProperty("year");
    expect(courses["Seminar"].year).toBe("2024-25");
    expect(body.profile.apScores).toEqual([{ exam: "US History", score: 5 }, { exam: "Biology", score: 4, year: 2025 }]);
    expect(body.activities[0]).not.toHaveProperty("category");
    expect(body.activities[0]).not.toHaveProperty("timing");
    expect(body.activities[0].id).toBe("act-1");
    expect(body.baseRevision).toBe("r8");
    // The answer's revision is the base the next save is checked against.
    expect(ctx.setSyncBase).toHaveBeenCalledWith(expect.objectContaining({ serverRevision: "r9" }));
  });

  it("round-trips a fully stated record unchanged in those fields", async () => {
    const full = {
      profile: {
        gpa: { unweighted: 3.9, weighted: 4.4 },
        courses: [{ name: "Calculus BC", type: "ap", grade: "A", year: "senior", semester: "full_year" }],
        apScores: [{ exam: "Calculus BC", score: 5, year: 2026 }],
        testScores: [],
      },
      activities: [{ id: "a2", name: "Debate", role: "Captain", category: "debate_speech", timing: "both", grades: ["junior"], hoursPerWeek: 4 }],
      goals: ["Small liberal arts"],
      majorInterest: "Economics",
    };
    const { body } = await roundTrip(full);
    expect(body.profile.courses).toEqual(full.profile.courses);
    expect(body.profile.apScores).toEqual(full.profile.apScores);
    expect(body.profile.gpa).toEqual({ unweighted: 3.9, weighted: 4.4 });
    expect(body.activities[0]).toMatchObject({ id: "a2", category: "debate_speech", timing: "both", grades: ["junior"], hoursPerWeek: 4 });
  });

  it("on a conflict keeps the editor's changes, takes the rest from the other device and saves once more", async () => {
    const state = hydrateInto(stored);
    const conflictProfile = { ...stored.profile, testScores: [{ test: "sat", totalScore: 1500 }], activities: stored.activities, goals: stored.goals, majorInterest: "Engineering" };
    const responses = [
      { ok: false, status: 409, json: async () => ({ code: "profile_revision_conflict", revision: "r12", profile: conflictProfile }) },
      { ok: true, status: 200, json: async () => ({ synced: true, setAside: [], revision: "r13" }) },
    ];
    const base = baseFromData(stored, "r11");
    const ctx = surveyCtx({
      ...state,
      sGpaUw: "3.8",
      sNoTestsYet: false,
      authedFetch: vi.fn(async () => responses.shift()),
      getSyncBase: () => base,
      setSyncBase: vi.fn(),
    });
    await handleSurveyComplete(ctx);
    expect(ctx.authedFetch).toHaveBeenCalledTimes(2);
    const second = JSON.parse(ctx.authedFetch.mock.calls[1][1].body);
    expect(second.baseRevision).toBe("r12");
    expect(second.profile.gpa.unweighted).toBe(3.8);
    expect(second.profile.testScores).toEqual([{ test: "sat", totalScore: 1500 }]);
    expect(ctx.setScreen).toHaveBeenCalledWith(S.CHAT);
    const [welcome] = ctx.setMessages.mock.calls[0][0];
    expect(welcome.content).toMatch(/Your profile changed on another device\./);
  });
});

describe("pulling the server's profile into the editor", () => {
  it("lets a newer server record win over a clean device copy, whatever the counts", async () => {
    const local = { profile: { gpa: { unweighted: 3.8 }, testScores: [{ test: "sat", totalScore: 1450 }], courses: [{ name: "Chem", grade: "B+" }] }, activities: [{ name: "Quit club" }], goals: [], majorInterest: "" };
    let base = baseFromData(local, "r1");
    let state = local;
    const serverProfile = { gpa: { unweighted: 3.85, weighted: 4.3 }, testScores: [{ test: "sat", totalScore: 1520 }], courses: [{ name: "Chem", grade: "A" }], activities: [{ name: "Robotics" }], apScores: [], goals: [], majorInterest: null };
    const ctx = {
      authedFetch: vi.fn(async () => ({ ok: true, json: async () => ({ revision: "r2", profile: serverProfile }) })),
      data: local,
      getSyncBase: () => base,
      setSyncBase: (next) => { base = next; },
      setProfileReady: vi.fn(),
      setData: (next) => { state = typeof next === "function" ? next(state) : next; },
    };
    const merged = await reconcileWithBackendProfile(ctx);
    expect(merged.profile.testScores[0].totalScore).toBe(1520);
    expect(state.profile.gpa).toEqual({ unweighted: 3.85, weighted: 4.3 });
    expect(state.activities).toEqual([{ name: "Robotics" }]);
    expect(base.serverRevision).toBe("r2");
    expect(ctx.setProfileReady).toHaveBeenCalledWith(true);
  });

  it("drops a read that a save overtook", async () => {
    let base = { serverRevision: "r1", snapshot: null };
    const ctx = {
      authedFetch: vi.fn(async () => { base = { serverRevision: "r2", snapshot: null }; return { ok: true, json: async () => ({ revision: "r1", profile: { courses: [] } }) }; }),
      data: { profile: { courses: [{ name: "Physics" }] } },
      getSyncBase: () => base,
      setSyncBase: vi.fn(),
      setData: vi.fn(),
    };
    await reconcileWithBackendProfile(ctx);
    expect(ctx.setData).not.toHaveBeenCalled();
    expect(ctx.setSyncBase).not.toHaveBeenCalled();
  });
});
