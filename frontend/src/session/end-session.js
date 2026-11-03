// end-session.js — what ending a student's session does outside React, the
// same for logging out, the inactivity expiry and deleting the account.
//
// The three exits each reset their own list of things, and the lists had
// drifted. Logging out revoked the server session but left the passphrase in
// the login field; the 15-minute expiry, which exists for shared school and
// family computers, revoked nothing, so the bearer token stayed valid on the
// server for its 7-day sliding lifetime and one click on "Sign in" opened the
// account again with the passphrase still typed in. Component state (the
// draft, attachments, open thread, College Fit card, survey answers) is
// cleared by remounting the student tree (App.jsx); this module ends
// everything that would outlive that remount.
import { endSessionReauth, rateLimiter } from "../chat/chat-client.js";
import { clearSession } from "./vault-storage.js";
import { sessionTimer } from "./server-session.js";

// The server answers a logout at once; a stalled one must not hold the
// next student at the old screen, so the revoke runs on its own.
const REVOKE_TIMEOUT_MS = 5000;

// Best-effort revoke of one bearer token. It is sent with the token in hand,
// not through authedFetch, so a 401 can never re-authenticate on the way out.
export function revokeServerSession(token) {
  if (!token) return Promise.resolve(false);
  let signal;
  try { signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(REVOKE_TIMEOUT_MS) : undefined; } catch { signal = undefined; }
  return fetch("/api/students/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    credentials: "same-origin",
    keepalive: true,
    ...(signal ? { signal } : {}),
  }).then((r) => Boolean(r?.ok), () => false);
}

// Ends the session in order: no background request may sign back in, the
// token is dropped before anything else can read it, the server is asked to
// revoke it, and every in-flight request is aborted. Resolves once the local
// part is done; the revoke is returned separately so the caller need not
// wait on the network before the next student sees a clean screen.
export async function closeStudentSession({ controllers = [] } = {}) {
  endSessionReauth();
  const token = window.__CC_SESSION_TOKEN__;
  window.__CC_SESSION_TOKEN__ = null;
  const revoked = revokeServerSession(token);
  for (const controller of controllers) {
    try { controller?.abort(); } catch { /* already aborted */ }
  }
  sessionTimer.clear();
  rateLimiter.reset();
  await clearSession();
  return { revoked };
}
