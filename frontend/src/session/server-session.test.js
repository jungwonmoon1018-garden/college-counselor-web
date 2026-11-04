import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healMissingConsents } from "./server-session.js";
import { closeStudentSession } from "./end-session.js";
import { _tryReAuth, setReauthCredentialProvider } from "../chat/chat-client.js";

// The consent heal exists for accounts from older signup builds that never
// recorded all three onboarding consents. A consent the student withdrew is
// missing too, and the heal used to grant it straight back at the next
// sign-in or the next 403.
describe("healing the onboarding consents", () => {
  let grants;
  let status;

  beforeEach(() => {
    grants = [];
    status = { consents: {}, missing: [] };
    window.__CC_SESSION_TOKEN__ = "tok_1";
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      if (path.includes("/api/consent/status")) return { ok: true, json: async () => status };
      if (path.includes("/api/consent/grant")) { grants.push(JSON.parse(options.body).consentType); return { ok: true, json: async () => ({ granted: true }) }; }
      return { ok: true, json: async () => ({}) };
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; });

  it("grants a consent that was never recorded", async () => {
    status = { missing: ["cross_border_transfer"] };
    expect(await healMissingConsents()).toEqual(["cross_border_transfer"]);
    expect(grants).toEqual(["cross_border_transfer"]);
  });

  it("never grants back a consent the student withdrew", async () => {
    status = { missing: ["ai_interaction", "cross_border_transfer"], revoked: ["ai_interaction"] };
    expect(await healMissingConsents()).toEqual(["cross_border_transfer"]);
    expect(grants).toEqual(["cross_border_transfer"]);

    grants = [];
    status = { missing: ["ai_interaction"], revoked: ["ai_interaction"] };
    expect(await healMissingConsents()).toEqual([]);
    expect(grants).toEqual([]);
  });

  it("reads an older server's answer, with no revoked list, as before", async () => {
    status = { missing: ["data_processing", "not_an_onboarding_type"] };
    expect(await healMissingConsents()).toEqual(["data_processing"]);
    expect(grants).toEqual(["data_processing"]);
  });
});

describe("closing a session", () => {
  let calls;
  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      calls.push({ path: String(url), method: options.method || "GET", headers: options.headers || {} });
      return { ok: true, json: async () => ({ token: "tok_again" }) };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); window.__CC_SESSION_TOKEN__ = null; setReauthCredentialProvider(null); });

  it("revokes the token it holds, drops it, aborts what is in flight and ends silent re-auth", async () => {
    window.__CC_SESSION_TOKEN__ = "tok_A";
    setReauthCredentialProvider(() => ({ email: "a@school.edu", password: "correct-horse-battery" }));
    const chat = new AbortController();
    const session = new AbortController();
    const { revoked } = await closeStudentSession({ controllers: [chat, null, session] });
    expect(await revoked).toBe(true);
    expect(window.__CC_SESSION_TOKEN__).toBeNull();
    expect(chat.signal.aborted).toBe(true);
    expect(session.signal.aborted).toBe(true);
    expect(calls).toEqual([{ path: "/api/students/logout", method: "POST", headers: { Authorization: "Bearer tok_A" } }]);
    // A background request that finds no token can no longer sign back in.
    expect(await _tryReAuth()).toBe(false);
    expect(calls.filter((c) => c.path.includes("/api/students/auth"))).toEqual([]);
  });

  it("sends nothing to revoke when there is no token", async () => {
    const { revoked } = await closeStudentSession();
    expect(await revoked).toBe(false);
    expect(calls).toEqual([]);
  });
});
