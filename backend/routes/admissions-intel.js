// routes/admissions-intel.js — the /api/admissions-intel routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (admissionsIntelStmts, normalizeUnitId, requireStudentAuth, studentLimiter).
import { resolveIpedsGrowthForMajor } from "../colleges/admissions-intelligence.js";

export function registerAdmissionsIntelRoutes(app, deps) {
  // ═══════════════════════════════════════════════════════════
  // HEALTH CHECK
  // ═══════════════════════════════════════════════════════════

  app.get("/api/admissions-intel/ipeds-growth", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const unitId = deps.normalizeUnitId(req.query.unitId);
      const major = String(req.query.major || "").trim();
      if (!major) return res.status(400).json({ error: "major is required" });
      const signal = resolveIpedsGrowthForMajor(deps.admissionsIntelStmts, { unitId, major });
      res.json({
        ok: true,
        unitId: unitId || null,
        major,
        signal,
        source: "NCES IPEDS completions",
      });
    } catch (err) {
      console.error("[ADMISSIONS-INTEL ipeds read] Error:", err.message);
      res.status(500).json({ error: "IPEDS growth lookup failed" });
    }
  });
}
