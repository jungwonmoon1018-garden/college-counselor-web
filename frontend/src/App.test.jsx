import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import App from "./App.jsx";

// These tests exist because the local-account-registry removal left App.jsx
// calling helpers that no longer existed (loadAccounts/loadSession). The mount
// effect threw a ReferenceError before it could route, so the app sat on
// "Loading your vault..." forever — in dev *and* in the packaged build — while
// the suite stayed green, because nothing rendered App.jsx.
function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

describe("App boot", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok:true, json:async()=>({}) }));
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("routes to the login screen on mount instead of hanging on the loading state", async () => {
    render(<App />);

    expect(await screen.findByText("Welcome back")).toBeVisible();
    expect(screen.queryByText("Loading your vault...")).not.toBeInTheDocument();
  });

  it("does not enumerate accounts on the device", async () => {
    // A shared machine must not disclose who has an account, and no plaintext
    // registry backs this screen any more.
    window.localStorage.setItem(
      "cc_accounts_registry",
      JSON.stringify({ "student@school.edu": { name:"Real Student", grade:"Junior" } }),
    );

    render(<App />);
    await screen.findByText("Welcome back");

    expect(screen.queryByText("Accounts on this device")).not.toBeInTheDocument();
    expect(screen.queryByText(/Real Student/)).not.toBeInTheDocument();
    // The legacy registry is purged on mount rather than read.
    expect(window.localStorage.getItem("cc_accounts_registry")).toBeNull();
  });
});

describe("Returning login", () => {
  beforeEach(() => {
    // jsdom lacks crypto.subtle; the login flow hashes the email and re-seeds
    // the vault with WebCrypto, so back it with Node's implementation.
    if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      const json = (body) => ({ ok: true, status: 200, json: async () => body });
      if (method === "POST" && path.includes("/api/students/auth")) {
        return json({ token: "tok_test_1", studentId: "stu_test_1" });
      }
      if (path.includes("/api/students/budget")) return json({ grade: 11 });
      if (path.includes("/api/students/export")) return json({ profile: { name: "Jiyeon Kim" } });
      return json({});
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  // Regression: the post-login routing referenced `serverUnreachable` and
  // `acct` — leftovers from the removed account registry that existed nowhere
  // — so EVERY returning login threw a ReferenceError after the server session
  // was established and the screen never left LOGIN. On the deployed site this
  // looked like the app locking users out after their first visit. This walks
  // the worst variant (device vault also missing): server-authoritative login
  // must recover identity, re-seed the vault, and land in the app.
  it("signs a returning student in even when the device vault is missing", async () => {
    render(<App />);
    await screen.findByText("Welcome back");

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jiyeon@school.edu" } });
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // No vault data and no backend profile → onboarding survey, step 0 (GPA).
    expect(await screen.findByText("What's your current GPA?", {}, { timeout: 15000 })).toBeVisible();
  }, 20000);
});
