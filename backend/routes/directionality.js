// routes/directionality.js — the /api/directionality routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (ragStmts, requireStudentAuth, safeParseJSON, studentLimiter).
import { recomputeStudentDirectionality } from "../ec-vectorizer.js";

export function registerDirectionalityRoutes(app, deps) {
  // ═══════════════════════════════════════════════════════════
  // STUDENT DIRECTIONALITY ENDPOINTS
  // ═══════════════════════════════════════════════════════════

  // GET: retrieve latest directionality vector for the student
  app.get("/api/directionality", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const dirVector = deps.ragStmts.directionality.getByStudent.get(req.studentId);
      if (!dirVector) {
        return res.status(404).json({ error: "No directionality vector computed yet" });
      }

      res.json({
        ok: true,
        studentId: req.studentId,
        directionality: {
          id: dirVector.id,
          factors: {
            academic_momentum: dirVector.academic_momentum,
            test_score_strength: dirVector.test_score_strength,
            major_academic_fit: dirVector.major_academic_fit,
            rigor_and_challenge: dirVector.rigor_and_challenge,
            overall_academic_standing: dirVector.overall_academic_standing,
          },
          label: dirVector.directionality_label,
          metrics: {
            gpaUnweighted: dirVector.gpa_unweighted,
            gpaPercentileT20: dirVector.gpa_percentile_t20,
            apCount: dirVector.ap_count,
            satTotal: dirVector.sat_total,
            satPercentileT20: dirVector.sat_percentile_t20,
            actTotal: dirVector.act_total,
            actPercentileT20: dirVector.act_percentile_t20,
            majorInterest: dirVector.major_interest,
          },
          reasoning: deps.safeParseJSON(dirVector.reasoning_json, []),
          isOverridden: Boolean(dirVector.is_overridden),
          computedAt: dirVector.computed_at,
          updatedAt: dirVector.updated_at,
        },
      });
    } catch (err) {
      console.error("[DIR] Retrieval error:", err.message);
      res.status(500).json({ error: "Directionality retrieval failed" });
    }
  });

  // POST: student manually overrides directionality factors
  app.post("/api/directionality/override", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { academic_momentum, test_score_strength, major_academic_fit, rigor_and_challenge, overall_academic_standing } = req.body || {};

      // Validate factor values are in [0, 1]
      const overrides = {};
      if (academic_momentum !== undefined) {
        if (typeof academic_momentum !== "number" || academic_momentum < 0 || academic_momentum > 1) {
          return res.status(400).json({ error: "academic_momentum must be a number in [0, 1]" });
        }
        overrides.academic_momentum = academic_momentum;
      }
      if (test_score_strength !== undefined) {
        if (typeof test_score_strength !== "number" || test_score_strength < 0 || test_score_strength > 1) {
          return res.status(400).json({ error: "test_score_strength must be a number in [0, 1]" });
        }
        overrides.test_score_strength = test_score_strength;
      }
      if (major_academic_fit !== undefined) {
        if (typeof major_academic_fit !== "number" || major_academic_fit < 0 || major_academic_fit > 1) {
          return res.status(400).json({ error: "major_academic_fit must be a number in [0, 1]" });
        }
        overrides.major_academic_fit = major_academic_fit;
      }
      if (rigor_and_challenge !== undefined) {
        if (typeof rigor_and_challenge !== "number" || rigor_and_challenge < 0 || rigor_and_challenge > 1) {
          return res.status(400).json({ error: "rigor_and_challenge must be a number in [0, 1]" });
        }
        overrides.rigor_and_challenge = rigor_and_challenge;
      }
      if (overall_academic_standing !== undefined) {
        if (typeof overall_academic_standing !== "number" || overall_academic_standing < 0 || overall_academic_standing > 1) {
          return res.status(400).json({ error: "overall_academic_standing must be a number in [0, 1]" });
        }
        overrides.overall_academic_standing = overall_academic_standing;
      }

      if (Object.keys(overrides).length === 0) {
        return res.status(400).json({ error: "At least one factor must be provided" });
      }

      deps.ragStmts.directionality.applyOverride.run(
        overrides.academic_momentum ?? null,
        overrides.test_score_strength ?? null,
        overrides.major_academic_fit ?? null,
        overrides.rigor_and_challenge ?? null,
        overrides.overall_academic_standing ?? null,
        JSON.stringify(overrides),
        req.studentId
      );

      res.json({
        ok: true,
        studentId: req.studentId,
        overridden: Object.keys(overrides),
        appliedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[DIR] Override error:", err.message);
      res.status(500).json({ error: "Directionality override failed" });
    }
  });

  // POST: force full recomputation of directionality vector
  app.post("/api/directionality/recompute", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      if (!snap) return res.status(404).json({ error: "No profile data" });

      const snapshotHistory = deps.ragStmts.getSnapshotHistory.all(req.studentId, 2) || [];
      const priorSnapshot = snapshotHistory.length > 1 ? snapshotHistory[1] : null;
      const allSnapshots = deps.ragStmts.getSnapshotHistory.all(req.studentId, 10) || [];
      const gpaBaselines = deps.ragStmts.getGPABaseline.all("t20_admitted") || [];
      const satBaselines = deps.ragStmts.getSATBaseline.all("t20_admitted") || [];
      const actBaselines = deps.ragStmts.getACTBaseline.all("t20_admitted") || [];
      const collegeProfiles = deps.ragStmts.searchColleges.all() || [];

      const result = recomputeStudentDirectionality(
        deps.ragStmts.directionality, req.studentId, snap, priorSnapshot,
        allSnapshots, gpaBaselines, satBaselines, actBaselines, collegeProfiles
      );

      res.json({
        ok: true,
        studentId: req.studentId,
        directionality: {
          id: result.id,
          factors: result.factors,
          label: result.label,
          reasoning: result.reasoning,
          isOverridden: result.isOverridden,
          computedAt: result.computedAt,
        },
      });
    } catch (err) {
      console.error("[DIR] Recompute error:", err.message);
      res.status(500).json({ error: "Directionality recomputation failed" });
    }
  });

  // GET: retrieve historical directionality vectors (trend analysis)
  app.get("/api/directionality/trend", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const history = deps.ragStmts.directionality.getByStudentHistory.all(req.studentId) || [];

      res.json({
        ok: true,
        studentId: req.studentId,
        history: history.map(row => ({
          id: row.id,
          factors: {
            academic_momentum: row.academic_momentum,
            test_score_strength: row.test_score_strength,
            major_academic_fit: row.major_academic_fit,
            rigor_and_challenge: row.rigor_and_challenge,
            overall_academic_standing: row.overall_academic_standing,
          },
          label: row.directionality_label,
          computedAt: row.computed_at,
        })),
        count: history.length,
      });
    } catch (err) {
      console.error("[DIR] Trend error:", err.message);
      res.status(500).json({ error: "Directionality trend retrieval failed" });
    }
  });
}
