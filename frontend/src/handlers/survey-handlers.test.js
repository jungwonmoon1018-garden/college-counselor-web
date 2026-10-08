import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSurveyComplete } from "./survey-handlers.js";
import { S } from "../app-shared.js";

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
