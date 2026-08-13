import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ADMIN_AUTH_RATE_LIMIT,
  AUTH_RATE_LIMIT,
  buildHealthResponse,
  isSensitiveResponsePath,
  redactProductionErrorBody,
  securityResponseMiddleware,
  shouldUseSecureAdminCookie,
} from "../security-hardening.js";

const SERVER = fs.readFileSync(fileURLToPath(new URL("../server.js", import.meta.url)), "utf8");

test("sensitive auth, admin, export, and context responses are marked no-store", () => {
  for (const path of [
    "/api/admin/session",
    "/api/students/auth",
    "/api/students/register",
    "/api/students/export",
    "/api/context/bundle",
    "/api/rag/context",
    "/api/calendar/context",
  ]) assert.equal(isSensitiveResponsePath(path), true, path);
  assert.equal(isSensitiveResponsePath("/api/health"), false);

  const headers = new Map();
  let sent;
  const res = {
    statusCode: 401,
    setHeader: (name, value) => headers.set(name, value),
    json(body) { sent = body; return this; },
  };
  securityResponseMiddleware({ production: true })(
    { path: "/api/students/auth" },
    res,
    () => res.json({ error: "Authentication failed", detail: "database path", stack: "secret" }),
  );
  assert.equal(headers.get("Cache-Control"), "no-store");
  assert.equal(headers.get("Pragma"), "no-cache");
  assert.deepEqual(sent, { error: "Authentication failed" });
  assert.match(SERVER, /app\.use\(securityResponseMiddleware\(\{ production: NODE_ENV === "production" \}\)\)/);
});

test("production error bodies redact implementation details while development remains useful", () => {
  const body = { error: "Request failed", detail: "upstream secret", message: "SQL text", stack: "trace", code: "failed" };
  assert.deepEqual(redactProductionErrorBody(body, 500, true), { error: "Request failed", code: "failed" });
  assert.deepEqual(redactProductionErrorBody({ message: "SQL text" }, 500, true), { error: "Internal server error" });
  assert.equal(redactProductionErrorBody(body, 500, false), body);
  assert.equal(redactProductionErrorBody(body, 200, true), body);
});

test("production health response is minimal", () => {
  assert.deepEqual(buildHealthResponse({ production: true, uptime: 99, details: { databases: { operational: "secret.db" } } }), { status: "ok" });
  const development = buildHealthResponse({ production: false, uptime: 99, timestamp: "now", details: { scorecard: true } });
  assert.deepEqual(development, { status: "ok", uptime: 99, timestamp: "now", scorecard: true });
  assert.match(SERVER, /res\.json\(buildHealthResponse\(/);
});

test("hosted admin cookies are always Secure", () => {
  assert.equal(shouldUseSecureAdminCookie({ webDeployment: true, requestSecure: false }), true);
  assert.equal(shouldUseSecureAdminCookie({ webDeployment: false, requestSecure: true }), true);
  assert.equal(shouldUseSecureAdminCookie({ webDeployment: false, requestSecure: false }), false);
  assert.match(SERVER, /shouldUseSecureAdminCookie\(\{ requestSecure: req\.secure, webDeployment: WEB_DEPLOYMENT \}\)/);
});

test("authentication surfaces have dedicated strict brute-force limits", () => {
  assert.deepEqual(AUTH_RATE_LIMIT, { windowMs: 900_000, max: 10 });
  assert.deepEqual(ADMIN_AUTH_RATE_LIMIT, { windowMs: 900_000, max: 5 });
  assert.match(SERVER, /app\.post\("\/api\/students\/auth", authLimiter/);
  assert.match(SERVER, /app\.post\("\/api\/admin\/login", adminAuthLimiter/);
  assert.match(SERVER, /app\.post\("\/api\/admin\/recover", adminAuthLimiter/);
});

test("CSP blocks inline scripts and adds restrictive navigation directives", () => {
  assert.match(SERVER, /scriptSrc:\s*\["'self'"\]/);
  assert.match(SERVER, /objectSrc:\s*\["'none'"\]/);
  assert.match(SERVER, /frameAncestors:\s*\["'none'"\]/);
  assert.match(SERVER, /baseUri:\s*\["'self'"\]/);
  assert.match(SERVER, /formAction:\s*\["'self'"\]/);
});
