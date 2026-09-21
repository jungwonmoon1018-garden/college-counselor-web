// chat-client.js — the transport to POST /api/chat: input sanitizing, the
// client rate limiter, the call timeout, the silent re-authentication on a
// 401, the upload safety screen and the audit log call. Moved out of App.jsx
// on 2026-09-20.
// FIX 7d: Sanitize free-text inputs to prevent persistent prompt injection
// `maxChars` defaults to a budget far above any attachment preface: the old
// hard cap of 500 characters silently truncated every uploaded transcript or
// essay, and the model — seeing a file cut off mid-line — reported it as
// truncated and filled in the rest. Only the classifier inputs pass a small cap.
const SENTINEL_LINE_RE = /^\s*\[(?:Attached files —|End of attached files\]|Context appendix —|End context appendix\]|Note: [^\]]*skipped)/i;

export function sanitizeInput(text, maxChars = 200_000) {
  if (!text) return "";
  // Normalize unicode homoglyphs (smart quotes, zero-width chars, lookalikes)
  let s = text.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, ""); // zero-width / invisible chars
  // Brackets go, except on the sentinel lines this client builds around
  // the question ("[Attached files \u2014 \u2026]", "[End of attached files]",
  // "[Context appendix \u2014 \u2026]", "[End context appendix]", "[Note: \u2026 skipped]"):
  // the server strips those blocks before classifying, and with the
  // brackets gone it classified the whole document and the calendar.
  s = s.split("\n").map((line) => (SENTINEL_LINE_RE.test(line) ? line : line.replace(/[\[\]{}<>]/g, ""))).join("\n");
  // Broad pattern: catch "ignore/disregard/forget/override previous/prior/above/all instructions/prompts/rules"
  s = s.replace(/(ignore|disregard|forget|override|bypass|skip|drop)\s*(all\s*)?(previous|prior|above|earlier|system|original|initial)?\s*(instructions?|prompts?|rules?|directives?|guidelines?|constraints?)/gi, "[removed]");
  // Catch "you are now" / "act as" / "new instructions" prompt takeover attempts
  s = s.replace(/(you\s+are\s+now|act\s+as|new\s+(instructions?|role|persona)|pretend\s+(to\s+be|you\s+are)|system\s*:)/gi, "[removed]");
  return s.slice(0, maxChars);
}

// Client-side rate limit — burst guard ONLY.
// Original design (Mar 2026) gated to 15/min + 3/10s when the app
// proxied through the operator's key and every chat turn
// cost real money. The backend enforces the grade-based monthly budget and
// OpenRouter tier mix (Gemma 4 / DeepSeek V4 Flash 0731 / GPT-5.6 Luna)
// keeps a typical turn at fractions of a cent, the per-minute cap
// just frustrates legitimate use. Per-IP backend rate limits
// (apiLimiter, studentLimiter) still guard against credential
// scraping / abuse — this client guard exists only to stop a stuck
// "Send" button from firing the same request dozens of times.
export const rateLimiter = { timestamps: [], check() {
  const now = Date.now();
  this.timestamps = this.timestamps.filter(t => now - t < 10000); // last 10s only
  if (this.timestamps.length >= 3) return false; // 3 per 10s burst guard
  this.timestamps.push(now);
  return true;
}, reset() { this.timestamps = []; }};

// ═══════════════════════════════════════════════════════════
// BACKEND CHAT PROXY (administrator-managed OpenRouter)
// ═══════════════════════════════════════════════════════════
// All requests stay on the desktop application's same origin. The renderer
// cannot redirect credentials or student content to a caller-supplied host.
const CHAT_PATH = "/api/chat";

function formatStructuredChatResponse(body) {
  const answer = body.answer ? String(body.answer).trim() : "";
  const parts = [];
  if (answer) parts.push(answer);
  // The claim-lane names are the composer's full slugs ("verified_fact",
  // "student_provided_fact", "coaching_suggestion"). The old exact-match
  // check ("verified") never hit, so EVERY claim — loosely keyword-matched
  // facts about unrelated colleges, plus a bullet duplicating the entire
  // model answer — collapsed into one noisy "Coaching suggestions" block on
  // every turn. Match by prefix, drop anything that restates the answer,
  // and reserve the compliance decoration for regulated/high-stakes turns.
  const regulatedTurn = ["regulated", "high_stakes"].includes(String(body.topic_type || "").toLowerCase());
  const grouped = { verified:[], student:[] };
  for (const claim of (Array.isArray(body.claims) ? body.claims : [])) {
    const laneRaw = String(claim.lane || "");
    const lane = laneRaw.startsWith("verified") ? "verified" : laneRaw.startsWith("student") ? "student" : null;
    if (!lane) continue; // coaching-lane claims are the model text itself
    const text = String(claim.statement || claim.text || claim.claim || "").trim();
    if (!text || text === answer || answer.includes(text)) continue;
    const source = claim.source?.domain || claim.source?.url || "";
    grouped[lane].push(`- ${text}${lane === "verified" && source ? ` _(${source})_` : ""}`);
  }
  if (grouped.verified.length) parts.push("**Verified official facts**", ...grouped.verified);
  if (grouped.student.length && regulatedTurn) parts.push("**Student-provided facts**", ...grouped.student);
  if (regulatedTurn) {
    if (Array.isArray(body.limitations) && body.limitations.length) parts.push("**Limitations**", ...body.limitations.map((item) => `- ${String(item)}`));
    if (Array.isArray(body.actions) && body.actions.length) parts.push("**Next actions**", ...body.actions.map((item) => `- ${String(item.label || item.text || item)}`));
  }
  return parts.filter(Boolean).join("\n\n");
}

// Unique id for the backend's budget ledger. /api/chat REQUIRES a request_id
// for every paid model call (it reserves the per-student budget under it and
// rejects duplicates); without one the route 400s with "request_id is
// required for paid model calls" — which surfaced in the UI as the generic
// "Something went wrong while answering that" on every model-backed turn.
function newChatRequestId() {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// Hard cap per model call. Without one, a stalled provider call left the UI
// showing its status line ("Final safety check…") forever, with manual Cancel
// as the only way out. 120s is generous for a single LLM call; the abort
// reason carries a message formatUserFacingError knows how to present.
const MODEL_CALL_TIMEOUT_MS = 120_000;

function withCallTimeout(signal, ms) {
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error("The model call timed out")), ms);
  ctrl.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }, { once: true });
  return ctrl.signal;
}

export async function requestChat(payload, signal, locale = "en-US") {
  const lang = locale === "ko" ? "ko" : "en-US";
  const url = `${CHAT_PATH}?locale=${encodeURIComponent(lang)}`;
  const headers = { "Content-Type": "application/json", "Accept-Language": lang };
  // Send the session token for tenant authorization and usage accounting.
  if (window.__CC_SESSION_TOKEN__) {
    headers["Authorization"] = `Bearer ${window.__CC_SESSION_TOKEN__}`;
  }
  // Fresh id per call — each agent/tool-loop invocation is its own billed
  // model call, so ids must never repeat. The 401 re-auth retry below reuses
  // the same body safely: the first attempt failed auth before any budget
  // reservation happened.
  const requestBody = JSON.stringify({ request_id: newChatRequestId(), ...payload });

  let r = await fetch(url, { method: "POST", credentials: "same-origin", headers, body: requestBody, signal: withCallTimeout(signal, MODEL_CALL_TIMEOUT_MS) });

  // Auto re-authenticate on 401 (backend may have restarted, clearing in-memory tokens)
  if (r.status === 401) {
    console.warn("[requestChat] 401 — attempting re-authentication…");
    const refreshed = await _tryReAuth();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${window.__CC_SESSION_TOKEN__}`;
      r = await fetch(url, { method: "POST", credentials: "same-origin", headers, body: requestBody, signal: withCallTimeout(signal, MODEL_CALL_TIMEOUT_MS) });
    }
  }

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    // Backend may return { error: "string" } or { error: { message: "string" } }
    const errMsg = typeof e.error === "string" ? e.error : (e.error?.message || `API ${r.status}`);
    const err = new Error(errMsg);
    // A policy block ({ blocked: true }) carries the counselor's own reply —
    // for an essay-ghostwriting request, the coaching redirect (brainstorm,
    // outline, feedback). It is an answer to show, not a failure to hide
    // behind "Something went wrong".
    if (e.blocked === true) err.blocked = true;
    err.status = r.status;
    throw err;
  }

  const body = await r.json();
  if (body?.answer) {
    const expectsJson = /respond\s+(only\s+)?with\s+json|return\s+only\s+json/i.test(String(payload?.system || ""));
    const text = expectsJson ? String(body.answer) : formatStructuredChatResponse(body);
    const hasToolUse = Array.isArray(body.content) && body.content.some((block) => block.type === "tool_use");
    if (!hasToolUse || !Array.isArray(body.content) || body.content.length === 0) body.content = [{ type:"text", text }];
    body.structuredText = text;
  }
  return body;
}

// Lightweight observability for the otherwise-silent token re-auth. The React
// component registers a listener via setReauthListener; _tryReAuth reports
// "attempting" / "ok" / "failed" so the UI can show a non-blocking toast (and
// route to sign-in on terminal failure) instead of a confusing dead end.
let _reauthListener = null;

let _reauthCredentialProvider = null;
// Bumped when the student ends the session; a re-auth that was already in
// flight must not install the token it comes back with.
let _reauthEpoch = 0;

export function setReauthListener(fn) { _reauthListener = fn; }

export function setReauthCredentialProvider(fn) { _reauthCredentialProvider = fn; }

// Logging out (or deleting the account) ends silent re-authentication at
// once. App() also clears the provider from an effect, but only on its next
// render: until then any background authedFetch that found no token — the
// budget poll, a thread refresh — signed the student straight back in with
// the passphrase still held in the old closure, and a re-auth already in
// flight did the same when it resolved. The login screen showed while the
// page held a fresh session token.
export function endSessionReauth() {
  _reauthEpoch += 1;
  _reauthCredentialProvider = null;
}

function notifyReauth(status) { try { _reauthListener?.(status); } catch { /* ignore */ } }

// Re-authentication uses the password already held in component memory after
// the student unlocks. Passwords and bearer tokens are never read from or
// written to browser storage.
export async function _tryReAuth() {
  notifyReauth("attempting");
  const epoch = _reauthEpoch;
  try {
    const credentials = _reauthCredentialProvider?.();
    if (!credentials?.email || !credentials?.password) { notifyReauth("failed"); return false; }
    const r = await fetch("/api/students/auth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: credentials.email, password: credentials.password })
    });
    const d = await r.json().catch(() => ({}));
    if (epoch !== _reauthEpoch) { notifyReauth("failed"); return false; } // the session ended while this was in flight
    if (d.token) { window.__CC_SESSION_TOKEN__ = d.token; notifyReauth("ok"); console.info("[ReAuth] Session restored via auth"); return true; }
    notifyReauth("failed");
    return false;
  } catch (err) {
    console.warn("[ReAuth] Failed:", err?.message);
    notifyReauth("failed");
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// RECOMMENDATION 2: UPLOAD CONTENT SAFETY PRE-SCREENING
// ═══════════════════════════════════════════════════════════
// Pre-screens uploaded images/PDFs before sending to specialist agents.
// Uses a dedicated safety classifier to reject CSAM, explicit content,
// and inappropriate material before it ever reaches the counseling agents.

export async function screenUploadForSafety(fileData, signal) {
  const UPLOAD_SCREENER = {
    id: "upload_screener",
    label: "Upload Safety",
    color: "#E24B4A",
    tier: "small",
    maxTokens: 200,
    system: `You are a content safety screener for a K-12 education app used by students ages 14-18.
You review uploaded files (images, PDFs) BEFORE they are processed by the counseling system.
Your ONLY job: determine if the content is safe for an educational context.
REJECT ONLY if the file clearly contains: explicit/sexual content, violence/gore, CSAM (child sexual abuse material),
hate speech, drug paraphernalia, weapons, or nudity.
ACCEPT everything else that is plausibly a student's document: report cards, transcripts, score reports,
schedules, school documents, academic certificates, resumes, essay drafts, activity lists, award or
financial-aid letters, notes, screenshots of school portals — even if partially blurry, scanned, or oddly formatted.
A hard-to-read school document is SAFE — reject only for unsafe CONTENT, never for quality or ambiguity.
Respond ONLY with JSON: {"safe":true|false,"reason":"one sentence"}
If uncertain whether the content is unsafe, ACCEPT — downstream moderation runs on everything extracted from it.`,
    tools: []
  };

  const contentBlocks = [];
  if (fileData.type === "application/pdf") {
    contentBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: fileData.base64 } });
  } else {
    contentBlocks.push({ type: "image", source: { type: "base64", media_type: fileData.mediaType, data: fileData.base64 } });
  }
  contentBlocks.push({ type: "text", text: "Is this file safe and appropriate for a K-12 educational app? Respond with JSON only." });

  try {
    const d = await requestChat({
      tier: UPLOAD_SCREENER.tier,
      max_tokens: UPLOAD_SCREENER.maxTokens,
      system: UPLOAD_SCREENER.system,
      messages: [{ role: "user", content: contentBlocks }]
    }, signal);
    const text = d.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());
    return { safe: !!result.safe, reason: result.reason || "" };
  } catch (err) {
    // Fail CLOSED — if screening fails, reject the upload
    // But surface the real error so the user can fix it (auth, missing key, payload size, etc.)
    console.warn("Upload safety screening failed:", err?.message);
    const msg = err?.message || "";
    // Surface actionable errors instead of a generic message
    if (/no api key|noKey|not configured|service not configured/i.test(msg)) {
      return { safe: false, reason: "AI service not configured. Contact your school administrator." };
    }
    if (/sign in|session|unauthorized|401/i.test(msg)) {
      return { safe: false, reason: "Session expired. Please log out and log back in, then try again." };
    }
    if (/too large|payload|413|entity/i.test(msg)) {
      return { safe: false, reason: "File too large for processing. Try a smaller file (under 4 MB)." };
    }
    if (/rate|429|too many/i.test(msg)) {
      return { safe: false, reason: "Too many requests. Wait a moment and try again." };
    }
    if (/model not allowed/i.test(msg)) {
      return { safe: false, reason: "Model access error. Please contact support." };
    }
    return { safe: false, reason: `Safety screening failed: ${msg || "Unknown error"}. Please try again.` };
  }
}

// (score-report / transcript readers removed — feature retired)


// Safety diagnostics keep event codes only. Prompts, crisis text, emails, and
// model output are never copied into client logs or a public audit endpoint.
export const auditLog = {
  _events: [],
  log(eventType) {
    this._events.push({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), type: String(eventType || "unknown").slice(0, 64) });
    if (this._events.length > 100) this._events.shift();
  },
  getEvents(type) { return type ? this._events.filter((event) => event.type === type) : [...this._events]; },
};
