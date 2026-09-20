// routes/ec.js — the /api/ec routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (SPIKE_TIER_WEIGHT, assembleProfileForGeneration, buildStudentCallLLM, ecUpload, getSchoolPriorities, llmRankCandidates, llmRankSpike, parseLLMJson, prestigeExplanationFor, profileSummaryForPrompt, ragStmts, recomputeStrengthForStudent, requireCounselorAuth, requireStudentAuth, resolvePrestigeAdapter, resolveTargetSchools, respondLLMError, safeJSON, safeParseJSON, schoolPrioritiesPromptBlock, shapeLegacyECVectorFromStrengthRow, studentLimiter, tagIdeaWithNarrative).
import { EC_FACTORS, buildNextStepPlan, scoreAcademicStrength } from "../ec-vectorizer.js";
import { applyStrengthOverride, buildDefaultLLMClient, projectStrengthToLegacyVector, recomputeStudentECStrengthVectors, vectorizeECStrength } from "../ec-strength-vectorizer.js";
import { getActiveNarrative } from "../narrative-store.js";
import { enhancedCollegeMatch } from "../rag-engine.js";
import path from "node:path";
import crypto from "node:crypto";
import { ExtractionError, MAX_FILE_BYTES, SUPPORTED_MIME_TYPES, extractText } from "../file-extractors.js";
import fs from "node:fs";

export function registerEcRoutes(app, deps) {
  // ═══════════════════════════════════════════════════════════
  // EC VECTORIZER — 5-factor EC strength + well-being-first planner
  // ═══════════════════════════════════════════════════════════
  // Factors: impact_and_scope, leadership_and_initiative,
  //          passion_and_consistency, talents_and_awards,
  //          relevance_to_intended_major
  // Legacy-compatible EC vector surface projected from the unified strength system.
  // Academics interpreted ONLY via GPA and APs per policy.

  // GET legacy-compatible EC vectors for the current student
  app.get("/api/ec/vectors", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const rows = deps.ragStmts.strength.getByStudent.all(req.studentId);
      res.json({
        studentId: req.studentId,
        factors: EC_FACTORS,
        vectors: rows.map(deps.shapeLegacyECVectorFromStrengthRow).filter(Boolean),
        count: rows.length,
        sourceSystem: "ec_strength_vectors",
        disclaimer: "These are projected compatibility views from the unified EC strength system, open to correction.",
      });
    } catch (err) {
      console.error("[EC] Get vectors error:", err.message);
      res.status(500).json({ error: "Failed to fetch EC vectors" });
    }
  });

  // POST: vectorize ad-hoc (no persist) — useful for preview
  app.post("/api/ec/vectorize", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const { ec, majorInterest } = req.body || {};
      if (!ec || !ec.name) {
        return res.status(400).json({ error: "ec.name is required" });
      }
      const result = await vectorizeECStrength({
        ec,
        description: ec.description,
        majorInterest: majorInterest || null,
      });
      const projected = projectStrengthToLegacyVector(result.factors);
      res.json({
        ecName: ec.name,
        vector: projected.vector,
        composite: projected.composite,
        label: projected.label,
        strength: result,
        factors: EC_FACTORS,
        sourceSystem: "ec_strength_vectors",
        disclaimer: "Automated estimate projected from the unified EC strength system. Open to correction.",
      });
    } catch (err) {
      console.error("[EC] Vectorize error:", err.message);
      res.status(500).json({ error: "Vectorization failed" });
    }
  });

  // POST: force a full recompute of all unified EC vectors for this student
  // (normally happens automatically via syncStudentData)
  app.post("/api/ec/recompute", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      if (!snap) return res.status(404).json({ error: "No profile data" });
      const activities = deps.safeParseJSON(snap.activities_json, []);
      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      const prestigeAdapter = deps.resolvePrestigeAdapter(req.studentId);
      const result = await recomputeStudentECStrengthVectors(
        deps.ragStmts.strength, req.studentId,
        {
          activities,
          narrative: active?.narrativeText || null,
          narrativeThemes: active?.themes || [],
          narrativeHash: active?.hash || null,
          narrativeId: active?.id || null,
          majorInterest: snap.major_interest || null,
          llmClient: buildDefaultLLMClient(deps.ragStmts.narrativeFitCache),
          prestigeAdapter,
          ragStmts: deps.ragStmts,
        },
      );
      res.json({
        ok: true,
        count: result.count,
        vectors: result.vectors.map((row) => ({
          ecName: row.ecName,
          ...projectStrengthToLegacyVector(row.factors),
          sourceSystem: "ec_strength_vectors",
        })),
        recomputedAt: new Date().toISOString(),
        sourceSystem: "ec_strength_vectors",
      });
    } catch (err) {
      console.error("[EC] Recompute error:", err.message);
      res.status(500).json({ error: "Recompute failed" });
    }
  });

  // POST: student overrides one or more factor values for a specific EC
  app.post("/api/ec/override", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { ecName, overrides, reason } = req.body || {};
      if (!ecName || !overrides || typeof overrides !== "object") {
        return res.status(400).json({ error: "ecName and overrides object required" });
      }
      // Validate and clamp each factor
      const clamp = (v) => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.max(0, Math.min(1, n));
      };
      const existing = deps.ragStmts.strength.getByStudentAndName.get(req.studentId, ecName);
      if (!existing) {
        return res.status(404).json({ error: "EC not found. Sync your profile first." });
      }
      const mappedOverrides = {};
      if (overrides.impact_and_scope !== undefined) {
        mappedOverrides.achievement = clamp(overrides.impact_and_scope);
      }
      if (overrides.leadership_and_initiative !== undefined) {
        mappedOverrides.leadership = clamp(overrides.leadership_and_initiative);
      }
      if (overrides.passion_and_consistency !== undefined) {
        mappedOverrides.dedication = clamp(overrides.passion_and_consistency);
      }
      if (overrides.talents_and_awards !== undefined) {
        const n = clamp(overrides.talents_and_awards);
        mappedOverrides.achievement = n;
        mappedOverrides.prestige = n;
      }
      if (overrides.relevance_to_intended_major !== undefined) {
        mappedOverrides.major_spike = clamp(overrides.relevance_to_intended_major);
      }
      const result = applyStrengthOverride(deps.ragStmts.strength, req.studentId, ecName, mappedOverrides);
      const projected = projectStrengthToLegacyVector(result.factors);
      res.json({
        ok: true,
        ecName,
        vector: projected.vector,
        composite: projected.composite,
        label: projected.label,
        mappedToStrengthOverrides: mappedOverrides,
        isOverridden: true,
        sourceSystem: "ec_strength_vectors",
      });
    } catch (err) {
      console.error("[EC] Override error:", err.message);
      res.status(500).json({ error: "Override failed" });
    }
  });

  // POST: build a well-being-first next-step plan for this student
  app.post("/api/ec/plan", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { targetColleges, locale } = req.body || {};
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      if (!snap) return res.status(404).json({ error: "No profile data" });

      const activities = deps.safeParseJSON(snap.activities_json, []);
      const courses = deps.safeParseJSON(snap.courses_json, []);
      const apScores = deps.safeParseJSON(snap.ap_scores_json, []);
      const ecStrengthRows = ecStrengthStmts.getByStudent.all(req.studentId);

      // Resolve target colleges: accept unitId list, else fall back to top college match
      let colleges = [];
      if (Array.isArray(targetColleges) && targetColleges.length > 0) {
        for (const id of targetColleges) {
          const row = deps.ragStmts.getCollegeProfile.get(String(id));
          if (row) colleges.push(row);
        }
      }
      if (colleges.length === 0) {
        const match = enhancedCollegeMatch(deps.ragStmts, req.studentId, {});
        // Look up full rows for the top 5 matched colleges
        for (const r of (match.results || []).slice(0, 5)) {
          const row = deps.ragStmts.getCollegeProfile.get(r.unitId);
          if (row) colleges.push(row);
        }
      }

      const academicScore = scoreAcademicStrength(
        {
          gpaUnweighted: snap.gpa_unweighted,
          gpaWeighted: snap.gpa_weighted,
          apCourses: courses.filter(c => c.type === "ap" || c.level === "AP"),
          apScores,
        },
        colleges,
      );

      const plan = buildNextStepPlan({
        ecVectors: ecStrengthRows.map((r) => deps.shapeLegacyECVectorFromStrengthRow(r)?.vector).filter(Boolean),
        strengthVectors: ecStrengthRows.map((r) => ({
          ecName: r.ec_name,
          dedication: r.dedication,
          achievement: r.achievement,
          leadership: r.leadership,
          prestige: r.prestige,
          major_spike: r.major_spike,
          narrative_fit: r.narrative_fit,
        })),
        academicScore,
        activities,
        majorInterest: snap.major_interest,
        locale: locale || "en-US",
      });

      res.json({
        ok: true,
        studentId: req.studentId,
        majorInterest: snap.major_interest,
        plan,
        academicScore,
        targetsUsed: colleges.map(c => ({ unitId: c.unit_id, name: c.name })),
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[EC] Plan error:", err.message);
      res.status(500).json({ error: "Plan generation failed" });
    }
  });

  app.post("/api/ec/upload", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
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
        console.error("[EC upload] multer error:", mErr.message);
        return res.status(400).json({ error: "Upload failed" });
      }
      if (!req.file) return res.status(400).json({ error: "file required" });

      const studentId = req.studentId;
      const ecName = (req.body?.ec_name || "").toString().trim() || null;
      const description = (req.body?.description || "").toString().trim() || null;
      const tmpPath = req.file.path;

      let extractedText = "";
      let extractionStatus = "ok";
      let extractionError = null;
      let warning = null;
      try {
        const buf = fs.readFileSync(tmpPath);
        const result = await extractText(buf, req.file.mimetype);
        extractedText = (result?.text || "").slice(0, 20_000);
        warning = result?.warning || null;
      } catch (e) {
        if (e instanceof ExtractionError && ["content_type_mismatch", "archive_limits_exceeded"].includes(e.code)) {
          try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
          return res.status(e.code === "archive_limits_exceeded" ? 413 : 415).json({
            error: e.code === "archive_limits_exceeded"
              ? "Uploaded archive exceeds safe processing limits."
              : "Uploaded file content does not match its declared type.",
            code: e.code,
          });
        }
        extractionStatus = "failed";
        extractionError = e instanceof ExtractionError
          ? `${e.code}: ${e.message}`
          : String(e?.message || e).slice(0, 240);
      }

      // Hash the raw file bytes → dedupes re-uploads of the same certificate.
      let contentHash;
      try {
        contentHash = crypto.createHash("sha256").update(fs.readFileSync(tmpPath)).digest("hex");
      } catch {
        contentHash = crypto.randomUUID().replace(/-/g, "");
      }

      const ext = (req.file.originalname.match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase() || "";
      const finalPath = path.join(path.dirname(tmpPath), `${contentHash}${ext}`);
      try {
        if (!fs.existsSync(finalPath)) fs.renameSync(tmpPath, finalPath);
        else fs.unlinkSync(tmpPath); // duplicate content — keep existing
      } catch (e) {
        console.error("[EC upload] rename failed:", e.message);
      }

      const attachmentId = crypto.randomUUID();
      const extractedHash = extractedText
        ? crypto.createHash("sha256").update(extractedText).digest("hex")
        : null;

      try {
        deps.ragStmts.strength.insertAttachment.run(
          attachmentId, studentId, ecName,
          req.file.originalname, req.file.mimetype, req.file.size,
          finalPath, extractedText, extractedHash, extractedText.length,
          extractionStatus, extractionError,
        );
      } catch (e) {
        console.error("[EC upload] insert failed:", e.message);
        return res.status(500).json({ error: "Persist failed" });
      }

      // If an EC is named, kick off a single-student recompute so the new
      // evidence is immediately visible in /api/ec/strength. Fire-and-log;
      // client doesn't wait.
      if (ecName && extractionStatus === "ok") {
        const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
        const activities = snap ? deps.safeParseJSON(snap.activities_json, []) : [];
        const active = getActiveNarrative(deps.ragStmts.narrative, studentId);
        const prestigeAdapter = deps.resolvePrestigeAdapter(studentId);
        recomputeStudentECStrengthVectors(
          deps.ragStmts.strength, studentId,
          {
            activities,
            narrative: active?.narrativeText || null,
            narrativeThemes: active?.themes || [],
            narrativeHash: active?.hash || null,
            narrativeId: active?.id || null,
            majorInterest: snap?.major_interest || null,
            llmClient: buildDefaultLLMClient(deps.ragStmts.narrativeFitCache),
            prestigeAdapter,
            ragStmts: deps.ragStmts,
          },
        ).catch((err) => console.error("[EC upload] post-recompute failed:", err.message));
      }

      res.json({
        ok: true,
        attachment_id: attachmentId,
        ec_name: ecName,
        description,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
        extracted_chars: extractedText.length,
        preview: extractedText.slice(0, 400),
        status: extractionStatus,
        warning,
        error: extractionError,
      });
    });
  });

  

  

  
}
