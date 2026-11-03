// chat-client.js — the transport to POST /api/chat: input sanitizing, the
// client rate limiter, the call timeout, the silent re-authentication on a
// 401, the upload safety screen and the audit log call. Moved out of App.jsx
// on 2026-09-20.
import { formatCrisisReply, isCrisisReplyBody } from "./crisis-lexicon.js";
import { chatErrorFromResponse, clientTimeoutError, isAbortError, isSessionExpiry, readErrorBody } from "./chat-errors.js";

// FIX 7d: Sanitize free-text inputs to prevent persistent prompt injection
// `maxChars` defaults to a budget far above any attachment preface: the old
// hard cap of 500 characters silently truncated every uploaded transcript or
// essay, and the model — seeing a file cut off mid-line — reported it as
// truncated and filled in the rest. Only the classifier inputs pass a small cap.
const SENTINEL_LINE_RE = /^\s*\[(?:Attached files —|End of attached files\]|Context appendix —|End context appendix\]|Note: [^\]]*skipped)/i;

export function sanitizeInput(text, maxChars = 200_000) {
  if (!text) return "";
  // Strips zero-width and invisible characters only. Typographic quotes are
  // left alone here; the crisis lexicons normalize them themselves
  // (normalizeForLexicon), which this comment once claimed happened here.
  let s = text.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, ""); // zero-width / invisible chars
  // Brackets go, except on the sentinel lines this client builds around
  // the question ("[Attached files \u2014 \u2026]", "[End of attached files]",
  // "[Context appendix \u2014 \u2026]", "[End context appendix]", "[Note: \u2026 skipped]"):
  // the server strips those blocks before classifying, and with the
  // brackets gone it classified the whole document and the calendar.
  s = s.split("\n").map((line) => (SENTINEL_LINE_RE.test(line) ? line : line.replace(/[\[\]{}<>]/g, ""))).join("\n");
  // Broad pattern: catch "ignore/disregard/forget/override previous/prior/above/all instructions/prompts/rules"
  s = s.replace(/(ignore|disregard|forget|override|bypass|skip|drop)\s*(all\s*)?(previous|prior|above|earlier|system|original|initial)?\s*(instructions?|prompts?|rules?|directives?|guidelines?|constraints?)/gi, "[removed]");
  // Prompt-takeover phrases, each shaped like an order to the assistant.
  for (const re of TAKEOVER_RES) s = s.replace(re, "[removed]");
  return s.slice(0, maxChars);
}

// The takeover line used to take out every "act as", "new role", "pretend to
// be" and "system:" anywhere in the text, word boundaries or not, after the
// server's screen had stopped refusing those phrases: "I act as treasurer",
// "my new role as captain", "pretend to be an admissions officer and read my
// essay" and "the grading system: weighted" reached the model as "[removed]",
// and "contact as many professors" as "cont[removed] many professors". Each
// pattern now needs the shape of an instruction to the assistant: an AI
// identity after "act as" / "pretend", "you are now", "your new
// instructions", or a line that opens as a system turn.
const AI_IDENTITY = String.raw`(?:an?\s+|the\s+)?(?:[\w-]+\s+){0,2}?(?:AI|A\.I\.|chatbot|language\s+model|LLM|DAN|jailbroken|jailbreak|unfiltered|uncensored|unrestricted|developer\s+mode)\b`;
const TAKEOVER_RES = [
  /\byou\s+are\s+now\b/gi,
  new RegExp(String.raw`\b(?:act|behave|respond)\s+as\s+${AI_IDENTITY}`, "gi"),
  /\b(?:act|behave)\s+as\s+(?:if|though)\s+you\s+(?:have|had)\s+no\s+(?:rules|restrictions|filters|limits|guidelines)\b/gi,
  new RegExp(String.raw`\bpretend\s+(?:to\s+be|(?:that\s+)?you\s+(?:are|were))\s+${AI_IDENTITY}`, "gi"),
  /\bpretend\s+(?:that\s+)?you\s+(?:have|had)\s+no\s+(?:rules|restrictions|filters|limits|guidelines)\b/gi,
  /\b(?:your\s+)?new\s+(?:system\s+)?(?:instructions?|persona|rules)\s*:|\byour\s+new\s+(?:instructions?|persona|role|rules)\b/gi,
  /^\s*system\s*:/gim,
];

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
    if (Array.isArray(body.actions) && body.actions.length) parts.push("**Next actions**", ...body.actions.map((item) => `- ${actionLine(item)}`));
  }
  return parts.filter(Boolean).join("\n\n");
}

// An action is a string or an object: {label, url} from the composer and the
// no-source reply, {name, contact} from a resource list. String(object) used
// to print "[object Object]".
function actionLine(item) {
  if (!item || typeof item !== "object") return String(item ?? "");
  const label = String(item.label || item.name || item.text || "").trim();
  const detail = String(item.url || item.contact || "").trim();
  return [label, detail].filter(Boolean).join(" — ") || "";
}

// Thrown by requestChat when /api/chat answers with its deterministic crisis
// reply. The reply is not JSON and not a draft: a gatekeeper that parsed it
// fell back to safe_multi, and every specialist and the supervisor then got
// the same body and merged it into an ordinary answer. Throwing lets
// orchestrate() end the turn at whichever call it arrives on.
export class CrisisReplyError extends Error {
  constructor(body, locale = "en-US") {
    super("crisis_reply");
    this.name = "CrisisReplyError";
    this.crisisReply = true;
    this.body = body;
    this.text = formatCrisisReply(body, locale);
  }
}

export function isCrisisReplyError(err) {
  return Boolean(err && err.crisisReply === true && typeof err.text === "string");
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
// reason is a TimeoutError (code client_timeout), never an AbortError, so a
// timeout is not shown as the student's own Cancel.
const MODEL_CALL_TIMEOUT_MS = 120_000;

export function withCallTimeout(signal, ms, makeReason = () => clientTimeoutError()) {
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(makeReason()), ms);
  ctrl.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }, { once: true });
  return ctrl.signal;
}

// `locale` is the UI language. Every caller used to leave it out, so every
// call said en-US and a Korean student's crisis reply listed only US lines.
//
// `payload.mode === "utility"` marks a call whose reply is JSON for the
// client, not an answer for the student (the gatekeeper, the output
// validator, the upload screener). The server then leaves out the profile,
// the theme guard and the gate decoration, and this function hands back the
// model's text as it came. It used to guess from the prompt wording with a
// regex that matched neither the gatekeeper's "Respond ONLY with valid JSON"
// nor the validator's "Respond JSON only", so on any aid, cost or deadline
// text the JSON came back with Limitations and Next actions appended.
export async function requestChat(payload, signal, locale = "en-US") {
  const lang = locale === "ko" ? "ko" : "en-US";
  const url = `${CHAT_PATH}?locale=${encodeURIComponent(lang)}`;
  const headers = { "Content-Type": "application/json", "Accept-Language": lang, "X-CollegeApp-Locale": lang };
  const utility = payload?.mode === "utility";
  // Send the session token for tenant authorization and usage accounting.
  if (window.__CC_SESSION_TOKEN__) {
    headers["Authorization"] = `Bearer ${window.__CC_SESSION_TOKEN__}`;
  }
  // Fresh id per call — each agent/tool-loop invocation is its own billed
  // model call, so ids must never repeat, the 401 resend below included.
  const post = () => fetch(url, {
    method: "POST", credentials: "same-origin", headers,
    body: JSON.stringify({ request_id: newChatRequestId(), ...payload }),
    signal: withCallTimeout(signal, MODEL_CALL_TIMEOUT_MS),
  });

  let r = await post();

  // Re-authenticate on a 401 that is about the session (the backend may have
  // restarted, clearing in-memory tokens) and resend once. A 401 that names
  // the provider is the operator's key being refused: signing in again cannot
  // fix it, and each attempt spent the per-IP login limit. The resend carries
  // a new request_id: the first attempt may already have reserved budget
  // under its id and released it, and the ledger refuses a released id as if
  // the monthly budget were spent.
  if (r.status === 401) {
    const first = await readErrorBody(r);
    if (!isSessionExpiry(401, first)) throw chatErrorFromResponse(401, first, r.headers);
    console.warn("[requestChat] 401 — attempting re-authentication…");
    if (!(await _tryReAuth())) throw chatErrorFromResponse(401, first, r.headers);
    headers["Authorization"] = `Bearer ${window.__CC_SESSION_TOKEN__}`;
    r = await post();
  }

  // Every failure keeps the route's code, budget, missing consents and
  // Retry-After (chat-errors.js), so the student is told the real reason.
  if (!r.ok) throw chatErrorFromResponse(r.status, await readErrorBody(r), r.headers);

  const body = await r.json();
  // Before any formatting or JSON parse: a crisis reply ends the turn.
  if (isCrisisReplyBody(body)) throw new CrisisReplyError(body, lang);
  if (body?.answer) {
    const text = utility ? String(body.answer) : formatStructuredChatResponse(body);
    const hasToolUse = Array.isArray(body.content) && body.content.some((block) => block.type === "tool_use");
    if (!hasToolUse || !Array.isArray(body.content) || body.content.length === 0 || utility) body.content = [{ type:"text", text }];
    body.structuredText = text;
  }
  return body;
}

// The first JSON object in a utility call's reply. The small models wrap
// their verdict in prose ("Sure! Here is the result: {…}") or fences, and an
// older server may still prefix an advisory line or append Limitations; a
// strict JSON.parse turned each of those into "Unexpected token" and threw
// the verdict away. Braces inside strings are skipped. Null when there is no
// object to read.
export function parseUtilityJson(text) {
  const s = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  if (!s) return null;
  try {
    const whole = JSON.parse(s);
    if (whole && typeof whole === "object") return whole;
  } catch { /* look for an object inside */ }
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    const end = matchingBrace(s, start);
    if (end === -1) continue;
    try {
      const value = JSON.parse(s.slice(start, end + 1));
      if (value && typeof value === "object") return value;
    } catch { /* try the next opening brace */ }
  }
  return null;
}

function matchingBrace(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
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

export async function screenUploadForSafety(fileData, signal, locale = "en-US") {
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

  // The verdict is read tolerantly (parseUtilityJson) and asked for twice.
  // The strict JSON.parse that stood here turned an empty reply, or a safe
  // verdict wrapped in "Sure! Here is the result:", into "Safety screening
  // failed: Unexpected token…", and a student's transcript was refused as
  // not a school document. What the outcomes mean:
  //   - an explicit verdict is final, unsafe included, and never re-asked;
  //   - silence (an empty reply, the server's empty_model_reply, or the
  //     composer's "not enough information" sentence an older server put in
  //     place of one) twice is not a verdict: the file is not refused for it.
  //     It goes on as `screened: false`, through the server's input, crisis
  //     and output screens and the output validator, which every attachment
  //     turn runs, and orchestrate() tells the student the check was out;
  //   - prose with no verdict twice may be a refusal, so the file is held back
  //     as a try-again (`transient`), never as "not a school document";
  //   - a failed call (budget, consent, rate limit, outage) is thrown as its
  //     typed error, so the turn fails the way any other call does and the
  //     student's files go back into the composer.
  const ask = () => requestChat({
    mode: "utility",
    tier: UPLOAD_SCREENER.tier,
    max_tokens: UPLOAD_SCREENER.maxTokens,
    system: UPLOAD_SCREENER.system,
    messages: [{ role: "user", content: contentBlocks }]
  }, signal, locale);

  let sawProse = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text = "";
    try {
      const d = await ask();
      text = d.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
    } catch (err) {
      // A crisis reply is not a screening failure; orchestrate() ends the turn.
      if (isCrisisReplyError(err) || isAbortError(err) || signal?.aborted) throw err;
      if (err?.code !== "empty_model_reply") throw err;
      text = "";
    }
    const verdict = parseUtilityJson(text);
    const safe = verdict?.safe === true || verdict?.safe === "true" ? true
      : verdict?.safe === false || verdict?.safe === "false" ? false
        : null;
    if (safe !== null) return { safe, screened: true, reason: String(verdict.reason || "") };
    if (text.trim() && !SILENT_REPLY_RE.test(text.trim())) sawProse = true;
    console.warn(`[upload screen] no verdict on attempt ${attempt + 1}`);
  }
  if (sawProse) {
    return {
      safe: false,
      transient: true,
      screened: true,
      reason: locale === "ko"
        ? "지금은 이 파일을 확인할 수 없었어요. 잠시 후 다시 보내 주세요."
        : "We couldn't check this file just now. Please send it again in a moment.",
    };
  }
  return { safe: true, screened: false, reason: "" };
}

// The composer's sentence for a model reply with nothing in it; an older
// server sent it in place of an empty reply.
const SILENT_REPLY_RE = /^There is not enough information to produce a specific suggestion\.?$/i;

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
