// server-session.js — establishing the backend session, the three onboarding
// consents and their login heal, the identity read, and the idle-session timer.
// Moved out of App.jsx on 2026-09-20.
import { getEmailDomain } from "./app-shared.js";

// ─── Authoritative server-session establishment ──────────────────────────
// The single source of truth for "do we have a backend session?". Both the
// create and login flows MUST gate on this before entering authenticated
// screens — otherwise the API-key / survey / chat steps fail with
// "Not authenticated" (the root cause of users getting stranded when the
// backend was unreachable at sign-up/sign-in time).
//
// Sets window.__CC_SESSION_TOKEN__ on success. Returns one of:
//   { ok: true, token, studentId }
//   { existing: true }              — (create mode) account already exists server-side
//   { ok: false, offline: true }    — backend unreachable (transport failed)
//   { ok: false, reason }           — backend answered and rejected the credentials
//
// `offline` separates "the server said no" from "there was no server". Login
// treats the former as a hard rejection and the latter as degraded-but-allowed
// (the vault already decrypted on-device); create requires a reachable server
// either way, since the backend owns the credential.
export async function establishServerSession({ email, password, name, grade, mode }) {
  const post = async (path, body) => {
    const r = await fetch(`/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, d };
  };
  try {
    const gradeNumber = ({ Freshman:9, Sophomore:10, Junior:11, Senior:12 })[grade] || Number(grade);
    const regBody = { email, password, name, grade: gradeNumber, schoolDomain: getEmailDomain(email) };

    if (mode === "create") {
      // New-account signup: register directly. An existing email must NOT
      // silently drop the user into someone else's data — surface it so the
      // caller can route to login.
      const { ok, status, d } = await post("/students/register", regBody);
      if (status === 409 || d.code === "account_exists") return { existing: true };
      if (ok && d.token) { window.__CC_SESSION_TOKEN__ = d.token; return { ok: true, token: d.token, studentId: d.studentId, recoveryCode: d.recoveryCode || "" }; }
      return { ok: false, reason: d.error || `server returned ${status}` };
    }

    // Login never falls back to registration. Missing accounts and wrong
    // passwords receive the backend's same generic error.
    const res = await post("/students/auth", { email, password });
    if (res.ok && res.d.token) { window.__CC_SESSION_TOKEN__ = res.d.token; return { ok: true, token: res.d.token, studentId: res.d.studentId }; }
    return { ok: false, reason: res.d.error || `server returned ${res.status}` };
  } catch (err) {
    // Transport-level failure only — fetch rejects when it cannot reach the
    // backend. A reachable server that rejects credentials returns above.
    return { ok: false, offline: true, reason: err?.message || "network error" };
  }
}

const GRADE_LABELS = { 9: "Freshman", 10: "Sophomore", 11: "Junior", 12: "Senior" };

// ─── Onboarding consents ─────────────────────────────────────────────────
// The backend gates every AI operation on all three of these (see consent.js
// getRequiredConsentsForOperation). Signup must grant all three; older builds
// granted only the first two, so cross_border_transfer was missing and every
// AI feature 403'd. grantOnboardingConsents is shared by signup, the login
// heal, and the transcript-import retry.
export const ONBOARDING_CONSENT_TYPES = ["data_processing", "ai_interaction", "cross_border_transfer"];

export async function grantOnboardingConsents(types = ONBOARDING_CONSENT_TYPES) {
  const token = window.__CC_SESSION_TOKEN__;
  if (!token) return false;
  const headers = { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
  const results = await Promise.allSettled(types.map((consentType) =>
    fetch("/api/consent/grant", {
      method: "POST",
      headers,
      body: JSON.stringify({ consentType, grantedBy: "student" }),
    })
  ));
  return results.every((r) => r.status === "fulfilled" && r.value.ok);
}

// Grant only the onboarding consents the backend reports as missing — used to
// heal accounts created before signup recorded all three. Best-effort.
export async function healMissingConsents() {
  const token = window.__CC_SESSION_TOKEN__;
  if (!token) return;
  try {
    const r = await fetch("/api/consent/status", { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const body = await r.json();
    const missing = (body.missing || []).filter((type) => ONBOARDING_CONSENT_TYPES.includes(type));
    if (missing.length) await grantOnboardingConsents(missing);
  } catch { /* best-effort — the import retry covers the rest */ }
}

// ─── Identity recovery from the backend ──────────────────────────────────
// The vault is the normal home for name/grade, but a passphrase reset writes a
// fresh vault that cannot inherit them (the old blob is undecryptable by
// design). Rebuild identity from the authenticated session instead, so the
// student isn't stranded: grade comes back with the budget status and the name
// from the student's own data export. Best-effort — a null result just means
// the caller must ask the student again.
export async function fetchServerIdentity(token) {
  const get = async (path) => {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? r.json() : null;
  };
  try {
    const [budget, exported] = await Promise.all([
      get("/api/students/budget").catch(() => null),
      get("/api/students/export").catch(() => null),
    ]);
    const grade = GRADE_LABELS[Number(budget?.grade)];
    const name = exported?.profile?.name;
    return name && grade ? { name, grade } : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// SECURITY UTILITIES
// ═══════════════════════════════════════════════════════════
// Session timeout — 15 minutes of inactivity for child safety on shared devices
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

// Expiry wipes in-memory state (draft message, attachments) by design — but it
// must never do so SILENTLY. onWarn(true) fires a minute early so the student
// can touch anything (mouse/key/scroll all reset the timer) and keep working.
const SESSION_WARN_BEFORE_MS = 60 * 1000;

export const sessionTimer = {
  _timeout: null,
  _warnTimeout: null,
  _onExpire: null,
  _onWarn: null,
  reset(onExpire, onWarn) {
    this._onExpire = onExpire || this._onExpire;
    this._onWarn = onWarn || this._onWarn;
    if (this._timeout) clearTimeout(this._timeout);
    if (this._warnTimeout) clearTimeout(this._warnTimeout);
    if (this._onExpire) {
      this._timeout = setTimeout(() => { this._onExpire(); }, SESSION_TIMEOUT_MS);
    }
    if (this._onWarn) {
      this._onWarn(false); // any activity hides a visible warning
      this._warnTimeout = setTimeout(() => { this._onWarn(true); }, SESSION_TIMEOUT_MS - SESSION_WARN_BEFORE_MS);
    }
  },
  clear() {
    if (this._timeout) clearTimeout(this._timeout);
    if (this._warnTimeout) clearTimeout(this._warnTimeout);
    this._timeout = null; this._warnTimeout = null; this._onExpire = null; this._onWarn = null;
  }
};
