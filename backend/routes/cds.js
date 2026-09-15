// routes/cds.js — the /api/cds routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (db, ecUpload, getScorecardQueryCache, putScorecardQueryCache, ragStmts, requireStudentAuth, safeJSON, studentLimiter, withScorecardMeta).
import { extractGoalUnitIds } from "../rag-engine.js";
import { computeCdsQueryCacheKey, extractTargetSchoolNames, parseCdsDocument, resolveAndParseCdsTargets } from "../cds-search.js";
import { ExtractionError, MAX_FILE_BYTES, SUPPORTED_MIME_TYPES } from "../file-extractors.js";
import fs from "node:fs";

export function registerCdsRoutes(app, deps) {
  app.get("/api/cds/schools", deps.studentLimiter, deps.requireStudentAuth, (_req, res) => {
    try {
      const rows = deps.ragStmts.cds.listAll.all();
      res.json({
        total: rows.length,
        schools: rows.map((r) => ({
          slug: r.slug,
          school: r.school_name,
          tier: r.tier,
          year: r.year,
          admitRate: r.overall_admit_rate,
          sat: r.enrolled_sat_p25 != null
            ? { p25: r.enrolled_sat_p25, p75: r.enrolled_sat_p75 }
            : null,
          testPolicy: r.test_policy,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: "cds_list_failed", message: String(e.message).slice(0, 200) });
    }
  });

  app.get("/api/cds/school/:slug", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const { loadValidatedRecord, loadLatestValidation } = await import("./cds-validator.js");
      const slug = String(req.params.slug).slice(0, 100);
      const record = loadValidatedRecord(deps.ragStmts, slug);
      if (!record) return res.status(404).json({ error: "school_not_in_cache", slug });
      const validation = loadLatestValidation(deps.ragStmts, slug);
      res.json({ record, validation });
    } catch (e) {
      res.status(500).json({ error: "cds_lookup_failed", message: String(e.message).slice(0, 200) });
    }
  });

  app.get("/api/cds/validation/:slug", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const { loadLatestValidation } = await import("./cds-validator.js");
      const slug = String(req.params.slug).slice(0, 100);
      const v = loadLatestValidation(deps.ragStmts, slug);
      if (!v) return res.status(404).json({ error: "no_validation", slug });
      res.json(v);
    } catch (e) {
      res.status(500).json({ error: "cds_validation_lookup_failed", message: String(e.message).slice(0, 200) });
    }
  });

  app.get("/api/cds/targets", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      if (!snap) return res.status(404).json({ error: "No profile data" });

      const goals = deps.safeJSON(snap.goals_json, []);
      const goalUnitIds = extractGoalUnitIds(goals);
      const fallbackRows = goalUnitIds.map((unitId) => deps.db.prepare("SELECT unit_id, name FROM baseline_colleges WHERE unit_id = ?").get(unitId)).filter(Boolean);
      const targets = extractTargetSchoolNames(goals, fallbackRows);
      if (targets.length === 0) {
        return res.status(400).json({ error: "No target universities found in student goals" });
      }

      const forceRefresh = String(req.query.refresh || "").toLowerCase() === "true";
      const cachePayload = { cacheKey: computeCdsQueryCacheKey(targets), targets };
      if (!forceRefresh) {
        const cached = deps.getScorecardQueryCache("cds_targets", cachePayload);
        if (cached?.data) {
          return res.json(deps.withScorecardMeta({
            targets: cached.data.targets || targets,
            results: cached.data.results || [],
            source: "College Transitions CDS repository",
          }, {
            cached: true,
            cacheKind: "cds_targets",
            dataFreshness: "current",
          }));
        }
      }

      const results = await resolveAndParseCdsTargets(targets);
      const payload = {
        targets,
        results,
        source: "College Transitions CDS repository",
      };
      deps.putScorecardQueryCache("cds_targets", cachePayload, payload);
      res.json(deps.withScorecardMeta(payload, {
        cached: false,
        cacheKind: "cds_targets",
        dataFreshness: "current",
      }));
    } catch (err) {
      console.error("[CDS targets] Error:", err.message);
      res.status(500).json({ error: "CDS target lookup failed" });
    }
  });

  // POST /api/cds/parse - OCR/extract an uploaded CDS file, then parse the
  // admissions fields needed by positioning. This does not persist the document.
  app.post("/api/cds/parse", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    deps.ecUpload.single("file")(req, res, async (mErr) => {
      if (mErr) {
        if (mErr.code === "UNSUPPORTED_MIME") {
          return res.status(415).json({
            error: mErr.message,
            supported: Object.keys(SUPPORTED_MIME_TYPES),
          });
        }
        if (mErr.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: `File exceeds ${MAX_FILE_BYTES} bytes` });
        }
        console.error("[CDS parse] multer error:", mErr.message);
        return res.status(400).json({ error: "Upload failed" });
      }
      if (!req.file) return res.status(400).json({ error: "file required" });

      try {
        const buf = fs.readFileSync(req.file.path);
        const result = await parseCdsDocument(buf, {
          contentType: req.file.mimetype,
          url: req.file.originalname || "",
          imageOcrOptions: { languages: "eng", timeoutMs: 60_000 },
        });
        res.json({
          ok: true,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
          extraction: result.extraction,
          parsed: result.parsed,
          preview: result.text.slice(0, 800),
        });
      } catch (err) {
        const message = err instanceof ExtractionError
          ? `${err.code}: ${err.message}`
          : String(err?.message || err).slice(0, 240);
        console.error("[CDS parse] Error:", message);
        const validationStatus = err instanceof ExtractionError && err.code === "archive_limits_exceeded"
          ? 413
          : (err instanceof ExtractionError && err.code === "content_type_mismatch" ? 415 : 400);
        res.status(validationStatus).json({ error: "CDS parse failed", code: err?.code || "cds_parse_failed", detail: message });
      } finally {
        try {
          if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        } catch (err) {
          console.error("[CDS parse] temp cleanup failed:", err.message);
        }
      }
    });
  });
}
