import rateLimit from "express-rate-limit";

export const AUTH_RATE_LIMIT = Object.freeze({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

// /api/chat is limited per student, after sign-in, with a per-IP ceiling
// ahead of sign-in as the abuse guard. It was 30 calls a minute per IP, and
// one turn can make six calls (gatekeeper, upload screener, two specialists,
// supervisor, validator), so five students on one school, hagwon or dorm
// network used up the shared allowance between them and saw a generic
// error. 60 a minute is ten full turns for one student; 300 a minute from
// one address is far past a classroom and still stops a script.
export const CHAT_RATE_LIMIT = Object.freeze({
  windowMs: 60_000,
  perStudent: 60,
  perIp: 300,
});

// The 429 body every limiter here sends: a stable code the client words for
// the student, and how long to wait. express-rate-limit sets the Retry-After
// header itself before calling this (standard or legacy headers on).
export function rateLimitedHandler(message = "Too many requests. Wait a moment and try again.") {
  return (req, res, _next, options) => {
    const header = Number(res.getHeader("Retry-After"));
    const resetTime = req.rateLimit?.resetTime instanceof Date ? req.rateLimit.resetTime.getTime() : null;
    const retryAfterSeconds = Number.isFinite(header) && header > 0
      ? header
      : Math.max(1, Math.ceil(((resetTime ?? Date.now() + (options?.windowMs || 60_000)) - Date.now()) / 1000));
    if (!res.getHeader("Retry-After")) res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(options?.statusCode || 429).json({ error: message, code: "rate_limited", retryAfterSeconds });
  };
}

// The two chat limiters. `hashIP` keys the ceiling without keeping raw
// addresses; `relax` is server.js's test-only multiplier. The per-student
// limiter runs after requireStudentAuth and falls back to the address for a
// request that somehow reached it unauthenticated.
export function createChatRateLimiters({
  hashIP = (ip) => String(ip || ""),
  relax = (max) => max,
  windowMs = CHAT_RATE_LIMIT.windowMs,
  perStudent = CHAT_RATE_LIMIT.perStudent,
  perIp = CHAT_RATE_LIMIT.perIp,
} = {}) {
  const common = { windowMs, standardHeaders: "draft-7", legacyHeaders: false };
  const chatIpLimiter = rateLimit({
    ...common,
    limit: relax(perIp),
    keyGenerator: (req) => "ip:" + hashIP(req.ip),
    handler: rateLimitedHandler("Too many requests from this network. Wait a moment and try again."),
  });
  const chatStudentLimiter = rateLimit({
    ...common,
    limit: relax(perStudent),
    keyGenerator: (req) => (req.studentId ? "student:" + req.studentId : "ip:" + hashIP(req.ip)),
    handler: rateLimitedHandler("You're sending messages faster than the counselor can answer. Wait a moment and try again."),
  });
  return { chatIpLimiter, chatStudentLimiter };
}

export const ADMIN_AUTH_RATE_LIMIT = Object.freeze({
  windowMs: 15 * 60 * 1000,
  max: 5,
});

const SENSITIVE_RESPONSE_PATHS = Object.freeze([
  /^\/api\/admin(?:\/|$)/,
  /^\/api\/students\/(?:register|auth|recover|password|logout|logout-all)(?:\/|$)/,
  /^\/api\/students\/export(?:\/|$)/,
  /^\/api\/context(?:\/|$)/,
  /^\/api\/rag\/context(?:\/|$)/,
  /^\/api\/calendar\/context(?:\/|$)/,
]);

export function isSensitiveResponsePath(pathname) {
  const path = String(pathname || "").split("?", 1)[0];
  return SENSITIVE_RESPONSE_PATHS.some((pattern) => pattern.test(path));
}

export function redactProductionErrorBody(body, statusCode, production) {
  if (!production || Number(statusCode) < 400 || !body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const redacted = { ...body };
  const needsFallbackError = !redacted.error && Boolean(redacted.detail || redacted.message || redacted.stack || redacted.cause);
  delete redacted.detail;
  delete redacted.message;
  delete redacted.stack;
  delete redacted.cause;
  if (needsFallbackError) redacted.error = Number(statusCode) >= 500 ? "Internal server error" : "Request failed";
  return redacted;
}

export function securityResponseMiddleware({ production = false } = {}) {
  return (req, res, next) => {
    if (isSensitiveResponsePath(req.path || req.originalUrl)) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
    }

    const sendJson = res.json.bind(res);
    res.json = (body) => sendJson(redactProductionErrorBody(body, res.statusCode, production));
    next();
  };
}

// The origins the API answers besides the page's own. Development defaults
// to the Vite and preview ports on localhost; the website does not. Until
// 2026-10-09 production carried those three dev origins too, so a page on
// one of those ports on any visitor's machine passed the origin check that
// the admin routes also rely on. Nothing rode a session that way (student
// requests carry a bearer token and the admin cookie is SameSite=Strict),
// but the check should not admit origins the site never serves. The website
// is same-origin (isAllowedRequestOrigin), PUBLIC_APP_URL adds a custom
// domain, and an explicit ALLOWED_ORIGINS replaces the defaults either way.
const DEV_ORIGINS = "http://localhost:3000,http://localhost:5173,http://localhost:5180";
export function resolveAllowedOrigins({ configured = "", publicAppUrl = "", webDeployment = false } = {}) {
  const list = String(configured || "").trim() ? String(configured) : (webDeployment ? "" : DEV_ORIGINS);
  return [...new Set([...list.split(","), String(publicAppUrl || "")]
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean))];
}

export function shouldUseSecureAdminCookie({ requestSecure = false, webDeployment = false } = {}) {
  return Boolean(requestSecure || webDeployment);
}

export function buildHealthResponse({ production = false, uptime = 0, timestamp = new Date().toISOString(), details = {} } = {}) {
  if (production) return { status: "ok" };
  return { status: "ok", uptime, timestamp, ...details };
}
