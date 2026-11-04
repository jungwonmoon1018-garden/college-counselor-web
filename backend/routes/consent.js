// routes/consent.js — the /api/consent routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (hashIP, piiStmts, requireStudentAuth, stmts, studentLimiter).
import { describeConsentTypes, getOnboardingConsentRequirements, grantConsent, hasActiveConsent, isValidConsentType, revokeConsentType, revokedConsentTypes } from "../security/consent.js";
import crypto from "node:crypto";

export function registerConsentRoutes(app, deps) {
  // ═══════════════════════════════════════════════════════════
  // CONSENT ENDPOINTS
  // ═══════════════════════════════════════════════════════════

  // GET /api/consent/requirements — the onboarding consents, in the asked
  // locale. With ?types=a,b it describes those types instead: the consent
  // panel asks the student for a type a route requires that sign-up never
  // asked for, and it can offer one only when it is described here. This
  // route used to describe the onboarding three alone, so the panel could
  // never offer anything.
  app.get("/api/consent/requirements", (req, res) => {
    const isMinor = req.query.isMinor !== "false";
    const locale = typeof req.query.locale === "string" && req.query.locale ? req.query.locale : "en-US";
    if (req.query.types != null) {
      const types = [req.query.types].flat().join(",").split(",").map((type) => type.trim()).filter(Boolean).slice(0, 20);
      return res.json(describeConsentTypes(types, locale));
    }
    res.json(getOnboardingConsentRequirements(isMinor, locale));
  });

  // GET /api/consent/status — which onboarding consents are active for the
  // signed-in student. Lets the frontend heal accounts from older signup builds
  // that recorded only two of the three required rows (cross_border_transfer was
  // never granted, which 403'd every AI feature for those accounts).
  // `revoked` lists the types the student withdrew (their newest record is a
  // revocation). A revoked type is also missing, and the heal must leave it
  // alone: re-granting it would undo the student's withdrawal.
  app.get("/api/consent/status", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const types = ["data_processing", "ai_interaction", "cross_border_transfer"];
      const consents = Object.fromEntries(types.map((type) => [
        type, hasActiveConsent(deps.piiStmts, req.studentId, type).hasConsent,
      ]));
      res.json({
        consents,
        missing: types.filter((type) => !consents[type]),
        revoked: revokedConsentTypes(deps.piiStmts, req.studentId),
      });
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

  // POST /api/consent/revoke { consentType, revokedBy? } — withdraw a consent.
  // Every paid model call checks consent at the call (server/model-calls.js
  // buildStudentCallLLM), so AI features stop at once until it is granted
  // again. The audit row names the type and who withdrew it, nothing else.
  app.post("/api/consent/revoke", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const consentType = req.body?.consentType;
      const revokedBy = req.body?.revokedBy || "student";
      if (!consentType || !isValidConsentType(consentType)) {
        return res.status(400).json({ error: "A valid consentType is required", code: "invalid_consent_type" });
      }
      if (!["student", "parent_guardian"].includes(revokedBy)) {
        return res.status(400).json({ error: "revokedBy must be student or parent_guardian", code: "invalid_revoker" });
      }
      const result = revokeConsentType(deps.piiStmts, req.studentId, consentType, revokedBy);
      deps.stmts.insertAudit.run(crypto.randomUUID(), new Date().toISOString(), "consent_revoked", req.studentId.slice(0, 12), `${consentType} by ${revokedBy}`, deps.hashIP(req.ip));
      res.json({ revoked: true, consentType, count: result.count });
    } catch (err) {
      console.error("[CONSENT] Revoke error:", err.message);
      res.status(500).json({ error: "Consent operation failed" });
    }
  });
}
