// server/auth.js — session tokens, the hashed and encrypted values, the
// student and counselor auth middleware, the admin cookie, the origin and
// network checks in front of the admin surface. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (ADMIN_COOKIE, ALLOWED_ORIGINS, ENCRYPTION_KEY,
// LOCALHOST_ORIGIN_RE, NODE_ENV, TOKEN_TTL_MS, WEB_CONFIG_KEY,
// WEB_DEPLOYMENT, authStore, sessionStmts, sessionTokens).
import crypto from "node:crypto";
import { shouldUseSecureAdminCookie } from "../security-hardening.js";
import { isLoopbackAddress } from "../security-auth.js";

let deps;
export function bindAuth(serverDeps) { deps = serverDeps; }

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function createSessionToken(emailHash, studentId) {
  return deps.authStore.issueStudentSession(emailHash, studentId);
}

export function validateTokenLegacy(token) {
  if (!token) return null;
  const now = Date.now();
  // 1) Fast path — in-memory hot cache.
  let session = deps.sessionTokens.get(token);
  if (session) {
    if (now > session.expiresAt) { deps.sessionTokens.delete(token); try { deps.sessionStmts.del.run(hashToken(token)); } catch {} return null; }
    session.expiresAt = now + deps.TOKEN_TTL_MS;
    try { deps.sessionStmts.touch.run(session.expiresAt, hashToken(token)); } catch {}
    return session;
  }
  // 2) Cold path — survived a restart, look it up in SQLite and
  //    re-hydrate the Map. This is what fixes "Invalid or expired
  //    session token" after a backend restart.
  try {
    const row = deps.sessionStmts.get.get(hashToken(token));
    if (!row) return null;
    if (now > row.expires_at) { deps.sessionStmts.del.run(hashToken(token)); return null; }
    const rehydrated = { emailHash: row.email_hash, studentId: row.student_id, expiresAt: now + deps.TOKEN_TTL_MS };
    deps.sessionTokens.set(token, rehydrated);
    deps.sessionStmts.touch.run(rehydrated.expiresAt, hashToken(token));
    return rehydrated;
  } catch (e) {
    console.warn("[SESSION] DB lookup failed:", e.message);
    return null;
  }
}

export function validateToken(token) {
  return deps.authStore.validateStudentSession(token);
}

// ═══════════════════════════════════════════════════════════
// CRYPTO HELPERS
// ═══════════════════════════════════════════════════════════
export function hashIP(ip) {
  return crypto.createHash("sha256").update(`ip_salt_cc:${ip}`).digest("hex").slice(0, 16);
}

export function hashEmail(email) {
  return crypto.createHash("sha256").update(`email_salt_cc:${email.toLowerCase().trim()}`).digest("hex");
}

export function encryptValue(plaintext) {
  const key = Buffer.from(deps.ENCRYPTION_KEY, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

export function decryptValue(blob) {
  try {
    const [ivHex, tagHex, encrypted] = blob.split(":");
    const key = Buffer.from(deps.ENCRYPTION_KEY, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}

export function safeJSON(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; }
  catch { return fallback; }
}

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════
export function requireStudentAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Student session token required. Include Authorization: Bearer <token>" });
  }
  const session = validateToken(auth.split(" ")[1]);
  if (!session) return res.status(401).json({ error: "Invalid or expired session token." });
  req.studentEmailHash = session.emailHash;
  req.studentId = session.studentId;
  next();
}

export function requireSelf(req, res, next) {
  const requestedId = req.params?.id || req.params?.studentId || req.body?.student_id || req.query?.student_id;
  if (requestedId && requestedId !== req.studentId) {
    return res.status(403).json({ error: "Access denied", code: "student_scope_mismatch" });
  }
  next();
}

export function bearerToken(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

export function readCookie(req, name) {
  const cookieHeader = String(req.headers.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return "";
}

export function setAdminCookie(req, res, token) {
  const secure = shouldUseSecureAdminCookie({ requestSecure: req.secure, webDeployment: deps.WEB_DEPLOYMENT }) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${deps.ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=604800${secure}`);
}

export function clearAdminCookie(req, res) {
  const secure = shouldUseSecureAdminCookie({ requestSecure: req.secure, webDeployment: deps.WEB_DEPLOYMENT }) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${deps.ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure}`);
}

export function isAllowedRequestOrigin(req) {
  const origin = String(req.headers.origin || "").replace(/\/$/, "");
  if (!origin) return true;
  if (deps.ALLOWED_ORIGINS.includes(origin)) return true;
  if (deps.NODE_ENV !== "production" && deps.LOCALHOST_ORIGIN_RE.test(origin)) return true;
  if (deps.WEB_DEPLOYMENT) {
    const sameOrigin = `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
    return origin === sameOrigin;
  }
  return false;
}

export function hasAllowedAdminOrigin(req) {
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!req.headers.origin && mutating && deps.NODE_ENV === "production") return false;
  return isAllowedRequestOrigin(req);
}

export function hasDesktopBootstrapProof(req) {
  const expected = String(deps.WEB_DEPLOYMENT
    ? process.env.WEB_ADMIN_BOOTSTRAP_TOKEN
    : process.env.DESKTOP_BOOTSTRAP_TOKEN || "");
  if (!expected) return deps.NODE_ENV !== "production";
  const received = String(req.headers[deps.WEB_DEPLOYMENT ? "x-web-setup-token" : "x-desktop-bootstrap"] || "");
  const actualHash = crypto.createHash("sha256").update(received).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

export function requireAdminNetwork(req, res, next) {
  if (!deps.WEB_DEPLOYMENT && !isLoopbackAddress(req.socket?.remoteAddress)) {
    return res.status(403).json({ error: "Administrator access is local-only." });
  }
  next();
}

export function requireCounselorAuth(req, res, next) {
  if (!deps.WEB_DEPLOYMENT && !isLoopbackAddress(req.socket?.remoteAddress)) {
    return res.status(403).json({ error: "Administrator access is local-only." });
  }
  if (!hasAllowedAdminOrigin(req)) {
    return res.status(403).json({ error: "Administrator origin is not allowed." });
  }
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!deps.authStore.validateAdminSession(
    readCookie(req, deps.ADMIN_COOKIE),
    req.headers["x-csrf-token"],
    mutating,
  )) {
    return res.status(401).json({ error: "Administrator session required." });
  }
  next();
}

// ─── Counselor-auth admin endpoints ──────────────────────────────────
// Manual trigger for seasonal credible-source research. Body:
//   { colleges?: string[], topN?: number, subjects?: [{subject_id,name}], skipAP?: bool }
// Runs synchronously (keep the set small — default topN 5 — to stay within the
// request timeout; full sweeps belong on the scheduled job). Needs an
// OpenRouter operator key.
export function adminSessionResponse(req, res, result, status = 200) {
  setAdminCookie(req, res, result.token);
  return res.status(status).json({
    authenticated: true,
    csrfToken: result.csrfToken,
    ...(result.recoveryCode ? { recoveryCode: result.recoveryCode } : {}),
  });
}

export async function validateAdminSecret(kind, value) {
  const secret = String(value || "").trim();
  if (kind === "encryption") return { valid: /^[0-9a-f]{64}$/i.test(secret), kind };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    if (kind === "openrouter") {
      if (!/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(secret)) return { valid: false, kind };
      const response = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${secret}` }, signal: controller.signal,
      });
      return { valid: response.ok, kind };
    }
    if (kind === "scorecard") {
      if (secret !== "DEMO_KEY" && !/^[A-Za-z0-9]{20,64}$/.test(secret)) return { valid: false, kind };
      const url = new URL("https://api.data.gov/ed/collegescorecard/v1/schools.json");
      url.searchParams.set("api_key", secret);
      url.searchParams.set("_fields", "id");
      url.searchParams.set("_per_page", "1");
      const response = await fetch(url, { signal: controller.signal });
      return { valid: response.ok, kind };
    }
    return { valid: false, kind: "unknown" };
  } catch {
    return { valid: false, kind, unavailable: true };
  } finally {
    clearTimeout(timeout);
  }
}

export function requireWebConfiguration(req, res, next) {
  if (!deps.WEB_DEPLOYMENT) {
    return res.status(405).json({ error: "Secret changes require the website launcher.", code: "web_launcher_required" });
  }
  if (deps.WEB_CONFIG_KEY.length < 32) {
    return res.status(503).json({ error: "Encrypted website configuration is unavailable.", code: "web_config_unavailable" });
  }
  next();
}

export function scheduleWebConfigurationRestart() {
  setTimeout(() => {
    if (typeof process.send === "function") process.send({ type: "web-config-updated" });
  }, 200).unref();
}
