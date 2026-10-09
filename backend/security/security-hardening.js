export const AUTH_RATE_LIMIT = Object.freeze({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

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
