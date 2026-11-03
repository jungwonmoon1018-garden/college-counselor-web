import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadlines } from "./api.js";
import { endSessionReauth, setReauthCredentialProvider } from "./chat/chat-client.js";

// The tool cards (deadlines, narrative, EC tools) went through ccFetch,
// which had no re-authentication: after a session ended elsewhere every one
// of them failed while the chat healed itself (ui-12). ccFetch now retries
// once after the same silent re-auth, and never once the student logged out.
describe("ccFetch re-authentication", () => {
  let calls;

  beforeEach(() => {
    calls = [];
    window.__CC_SESSION_TOKEN__ = "stale-token";
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      calls.push({ path, auth: options.headers?.Authorization || null });
      if (path === "/api/students/auth") return { ok: true, status: 200, json: async () => ({ token: "fresh-token" }) };
      const fresh = options.headers?.Authorization === "Bearer fresh-token";
      const body = fresh ? { deadlines: [{ id: 1 }] } : { error: "unauthorized" };
      return { ok: fresh, status: fresh ? 200 : 401, text: async () => JSON.stringify(body) };
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    endSessionReauth();
    window.__CC_SESSION_TOKEN__ = null;
  });

  it("a 401 signs back in once and retries with the new token", async () => {
    setReauthCredentialProvider(() => ({ email: "student@example.test", password: "pw" }));
    const result = await deadlines.list();
    expect(result).toEqual({ deadlines: [{ id: 1 }] });
    const toDeadlines = calls.filter((c) => c.path.startsWith("/api/students/deadlines"));
    expect(toDeadlines.map((c) => c.auth)).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    expect(calls.filter((c) => c.path === "/api/students/auth")).toHaveLength(1);
  });

  it("after logout it does not sign back in, and the error says the session ended", async () => {
    setReauthCredentialProvider(() => ({ email: "student@example.test", password: "pw" }));
    endSessionReauth();
    const error = await deadlines.list().catch((err) => err);
    expect(error.status).toBe(401);
    expect(error.sessionEnded).toBe(true);
    expect(calls.filter((c) => c.path === "/api/students/auth")).toHaveLength(0);
    expect(calls.filter((c) => c.path.startsWith("/api/students/deadlines"))).toHaveLength(1);
  });

  it("a 401 that is not a session failure spends no hidden sign-in", async () => {
    setReauthCredentialProvider(() => ({ email: "student@example.test", password: "pw" }));
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = String(url);
      calls.push({ path });
      if (path === "/api/students/auth") return { ok: true, status: 200, json: async () => ({ token: "fresh-token" }) };
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: "Upstream key refused", code: "provider_auth_failed" }) };
    }));
    const error = await deadlines.list().catch((err) => err);
    expect(error.status).toBe(401);
    expect(error.sessionEnded).toBeUndefined();
    expect(calls.filter((c) => c.path === "/api/students/auth")).toHaveLength(0);
  });

  it("the server's coded session 401 signs back in", async () => {
    setReauthCredentialProvider(() => ({ email: "student@example.test", password: "pw" }));
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      calls.push({ path });
      if (path === "/api/students/auth") return { ok: true, status: 200, json: async () => ({ token: "fresh-token" }) };
      const fresh = options.headers?.Authorization === "Bearer fresh-token";
      return fresh
        ? { ok: true, status: 200, text: async () => JSON.stringify({ deadlines: [] }) }
        : { ok: false, status: 401, text: async () => JSON.stringify({ error: "Session expired", code: "session_invalid" }) };
    }));
    expect(await deadlines.list()).toEqual({ deadlines: [] });
    expect(calls.filter((c) => c.path === "/api/students/auth")).toHaveLength(1);
  });

  it("a second 401 after the retry is not retried again", async () => {
    setReauthCredentialProvider(() => ({ email: "student@example.test", password: "pw" }));
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = String(url);
      calls.push({ path });
      if (path === "/api/students/auth") return { ok: true, status: 200, json: async () => ({ token: "still-bad" }) };
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: "unauthorized" }) };
    }));
    const error = await deadlines.list().catch((err) => err);
    expect(error.sessionEnded).toBe(true);
    expect(calls.filter((c) => c.path.startsWith("/api/students/deadlines"))).toHaveLength(2);
    expect(calls.filter((c) => c.path === "/api/students/auth")).toHaveLength(1);
  });
});
