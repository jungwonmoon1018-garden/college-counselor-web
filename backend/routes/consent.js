// routes/consent.js — the /api/consent routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (hashIP, piiStmts, requireStudentAuth, stmts, studentLimiter).
import { getOnboardingConsentRequirements, grantConsent, hasActiveConsent } from "../consent.js";
import crypto from "node:crypto";

export function registerConsentRoutes(app, deps) {
  // ═══════════════════════════════════════════════════════════
  // CONSENT ENDPOINTS
  // ═══════════════════════════════════════════════════════════

  app.get("/api/consent/requirements", (req, res) => {
    const isMinor = req.query.isMinor !== "false";
    const locale = req.query.locale || "en-US";
    res.json(getOnboardingConsentRequirements(isMinor, locale));
  });

  // GET /api/consent/status — which onboarding consents are active for the
  // signed-in student. Lets the frontend heal accounts from older signup builds
  // that recorded only two of the three required rows (cross_border_transfer was
  // never granted, which 403'd every AI feature for those accounts).
  app.get("/api/consent/status", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const types = ["data_processing", "ai_interaction", "cross_border_transfer"];
      const consents = Object.fromEntries(types.map((type) => [
        type, hasActiveConsent(deps.piiStmts, req.studentId, type).hasConsent,
      ]));
      res.json({ consents, missing: types.filter((type) => !consents[type]) });
    } catch (err) {
      console.error("[CONSENT] Status error:", err.message);
      res.status(500).json({ error: "Consent status failed" });
    }
  });

  app.post("/api/consent/grant", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { consentType, grantedBy, locale } = req.body;
      if (!consentType) return res.status(400).json({ error: "consentType is required" });
      grantConsent(deps.piiStmts, req.studentId, consentType, { grantedBy, locale });
      deps.stmts.insertAudit.run(crypto.randomUUID(), new Date().toISOString(), "consent_granted", req.studentId.slice(0, 12), `${consentType} by ${grantedBy || "student"}`, deps.hashIP(req.ip));
      res.json({ granted: true, consentType });
    } catch (err) {
      console.error("[CONSENT] Error:", err.message);
      res.status(500).json({ error: "Consent operation failed" });
    }
  });
}
