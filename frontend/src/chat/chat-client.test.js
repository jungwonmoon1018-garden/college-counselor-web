import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _tryReAuth, endSessionReauth, setReauthCredentialProvider } from "./chat-client.js";

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
