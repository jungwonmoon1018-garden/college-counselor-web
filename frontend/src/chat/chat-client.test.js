import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _tryReAuth, endSessionReauth, isCrisisReplyError, requestChat, setReauthCredentialProvider } from "./chat-client.js";

function stubBody(body) {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("requestChat reply handling", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // A crisis body used to be formatted as an answer: its hotlines lived in
  // `actions`, shown only on regulated turns, so the text ended on a colon.
  it("throws a crisis reply before formatting, carrying the full resource text", async () => {
    stubBody({
      answer: "It sounds like you may be going through a difficult time. Please reach out to one of these resources:",
      actions: [{ name: "Suicide & Crisis Lifeline", contact: "988" }, { name: "Crisis Text Line", contact: "Text HOME to 741741" }],
      _meta: { deterministic: true, topicType: "CRISIS" },
    });
    const err = await requestChat({ system: "Respond ONLY with valid JSON.", messages: [] }).catch((e) => e);
    expect(isCrisisReplyError(err)).toBe(true);
    expect(err.text).toMatch(/988[\s\S]*741741/);
    expect(err.text).not.toMatch(/\[object Object\]/);
  });

  it("renders an official-source action as its label and link, not [object Object]", async () => {
    stubBody({
      answer: "I don't have verified admissions statistics for that school yet.",
      topic_type: "high_stakes",
      limitations: ["No figure is quoted without a verified official source."],
      actions: [{ label: "College Scorecard", url: "https://collegescorecard.ed.gov" }],
    });
    const body = await requestChat({ messages: [] });
    expect(body.structuredText).toContain("**Next actions**");
    expect(body.structuredText).toContain("College Scorecard — https://collegescorecard.ed.gov");
    expect(body.structuredText).not.toMatch(/\[object Object\]/);
  });
});

// Silent re-authentication keeps a session alive across a backend restart.
// It must stop the moment the student logs out: App() clears the credential
// provider from an effect, which runs a render later, and until 2026-09-21 a
// background request in that window — or a re-auth already in flight —
// installed a fresh session token behind the login screen.
describe("silent re-authentication ends with the session", () => {
  beforeEach(() => { window.__CC_SESSION_TOKEN__ = null; });
  afterEach(() => { vi.unstubAllGlobals(); setReauthCredentialProvider(null); window.__CC_SESSION_TOKEN__ = null; });

  it("restores a token while the student is signed in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ token: "tok_restored" }) })));
    setReauthCredentialProvider(() => ({ email: "jiyeon@school.edu", password: "correct-horse-battery" }));
    expect(await _tryReAuth()).toBe(true);
    expect(window.__CC_SESSION_TOKEN__).toBe("tok_restored");
  });

  it("does not sign in again once the session has ended, even with the provider's closure still alive", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ token: "tok_after_logout" }) }));
    vi.stubGlobal("fetch", fetchSpy);
    setReauthCredentialProvider(() => ({ email: "jiyeon@school.edu", password: "correct-horse-battery" }));
    endSessionReauth();
    expect(await _tryReAuth()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.__CC_SESSION_TOKEN__).toBeNull();
  });

  it("drops the token of a re-auth that was in flight when the session ended", async () => {
    let answer;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { answer = resolve; })));
    setReauthCredentialProvider(() => ({ email: "jiyeon@school.edu", password: "correct-horse-battery" }));
    const pending = _tryReAuth();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    endSessionReauth(); // the student logs out while the request is out
    answer({ ok: true, status: 200, json: async () => ({ token: "tok_late" }) });
    expect(await pending).toBe(false);
    expect(window.__CC_SESSION_TOKEN__).toBeNull();
  });

  it("works again after the next sign-in registers credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ token: "tok_next" }) })));
    endSessionReauth();
    setReauthCredentialProvider(() => ({ email: "jiyeon@school.edu", password: "correct-horse-battery" }));
    expect(await _tryReAuth()).toBe(true);
    expect(window.__CC_SESSION_TOKEN__).toBe("tok_next");
  });
});
