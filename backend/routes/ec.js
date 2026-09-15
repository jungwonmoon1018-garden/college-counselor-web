// routes/ec.js — the /api/ec routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (SPIKE_TIER_WEIGHT, assembleProfileForGeneration, buildStudentCallLLM, ecUpload, getSchoolPriorities, llmRankCandidates, llmRankSpike, parseLLMJson, prestigeExplanationFor, profileSummaryForPrompt, ragStmts, recomputeStrengthForStudent, requireCounselorAuth, requireStudentAuth, resolvePrestigeAdapter, resolveTargetSchools, respondLLMError, safeJSON, safeParseJSON, schoolPrioritiesPromptBlock, shapeLegacyECVectorFromStrengthRow, studentLimiter, tagIdeaWithNarrative).
import { EC_FACTORS, WELLBEING_LIMITS, buildNextStepPlan, matchMajorBucket as matchMajorBucketFn, scoreAcademicStrength } from "../ec-vectorizer.js";
import { STRENGTH_FACTORS, TIERS, applyStrengthOverride, buildDefaultLLMClient, projectStrengthToLegacyVector, recomputeStudentECStrengthVectors, toPublicShape as toStrengthPublicShape, vectorizeECStrength } from "../ec-strength-vectorizer.js";
import { NARRATIVE_MAX_CHARS, NARRATIVE_MIN_CHARS, NarrativeValidationError, computeProfileFingerprint, getActiveNarrative, saveNarrative, softDeleteNarrative } from "../narrative-store.js";
import { enhancedCollegeMatch } from "../rag-engine.js";
import path from "node:path";
import crypto from "node:crypto";
import { ExtractionError, MAX_FILE_BYTES, SUPPORTED_MIME_TYPES, extractText } from "../file-extractors.js";
import fs from "node:fs";
import { localizeFriendlyLabels, resolveLocale, t } from "../i18n.js";
import { FACTOR_FRIENDLY, PRESTIGE_SOURCE_FRIENDLY, TIER_FRIENDLY, enrichECVectorWithFriendly, renderFriendlyFactor, renderFriendlyPrestigeSource, renderFriendlyTier } from "../friendly-labels.js";
import { exemplarsPromptBlock, randomExemplarGroup } from "../crimson-ec-exemplars.js";
import { harvestStudentChatRecords } from "../ec-chat-evidence.js";
import * as chatHistory from "../chat-history.js";
import { OFFICIAL_COMPETITION_SOURCES, PRESTIGE_TTL_DAYS, REPUTABLE_DOMAINS, computePrestigeCacheKey, normalizeActivityName, researchCompetitionPrestige, searchCompetitionCatalog } from "../competition-research.js";

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

  // POST /api/ec/narrative — save a new narrative (deactivates prior active)
  app.post("/api/ec/narrative", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { narrative_text } = req.body || {};
      const result = saveNarrative(deps.ragStmts.narrative, req.studentId, narrative_text);
      res.json({
        ok: true,
        id: result.id,
        hash: result.hash,
        themes: result.themes,
        major_buckets: result.majorBuckets,
        active: true,
        min_chars: NARRATIVE_MIN_CHARS,
        max_chars: NARRATIVE_MAX_CHARS,
      });
    } catch (err) {
      if (err instanceof NarrativeValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      console.error("[EC narrative] save error:", err.message);
      res.status(500).json({ error: "Save failed" });
    }
  });

  // GET /api/ec/narrative — fetch the currently-active narrative
  app.get("/api/ec/narrative", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      res.json({ active: active || null });
    } catch (err) {
      console.error("[EC narrative] get error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // GET /api/ec/narrative/active — the active narrative flattened to the shape
  // the NarrativeEditor reads (narrative_text/id/created_at), plus `source`
  // ('student' | 'auto') and `profileStale` (true when the story predates
  // newly-added ECs/courses, by fingerprint). Returns null when none exists.
  app.get("/api/ec/narrative/active", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      if (!active) return res.json(null);
      let profileStale = false;
      try {
        const profile = deps.assembleProfileForGeneration(req.studentId);
        if (profile && active.profileFingerprint) {
          profileStale = active.profileFingerprint !== computeProfileFingerprint(profile);
        }
      } catch { /* non-fatal */ }
      res.json({
        id: active.id,
        narrative_text: active.narrativeText,
        text: active.narrativeText,
        themes: active.themes,
        major_buckets: active.majorBuckets,
        hash: active.hash,
        source: active.source,
        profile_fingerprint: active.profileFingerprint,
        profileStale,
        created_at: active.createdAt,
      });
    } catch (err) {
      console.error("[EC narrative active] get error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // DELETE /api/ec/narrative — soft-delete (sets is_active=0, preserves history)
  app.delete("/api/ec/narrative", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const info = softDeleteNarrative(deps.ragStmts.narrative, req.studentId);
      res.status(204).set("X-Deactivated", String(info.deactivated)).end();
    } catch (err) {
      console.error("[EC narrative] delete error:", err.message);
      res.status(500).json({ error: "Delete failed" });
    }
  });

  // POST /api/ec/candidates/rank — narrative-aware ranking of candidate ECs.
  // Jiyeon UX audit F6. The student types a shortlist of ideas she's debating
  // ("Start a bioinformatics club", "Translate at a patient foundation"); we
  // score each one against her ACTIVE narrative's themes + major buckets.
  // A fast deterministic keyword/bucket pass produces a baseline; when the
  // installation has OpenRouter configured, a budgeted semantic re-rank can
  // recognize genuine fit even with zero literal keyword overlap.
  app.post("/api/ec/candidates/rank", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const locale = resolveLocale(req);
      const { candidates, majorInterest } = req.body || {};
      if (!Array.isArray(candidates) || candidates.length === 0) {
        return res.status(400).json({ error: "candidates must be a non-empty array of {name, description?}" });
      }
      if (candidates.length > 25) {
        return res.status(400).json({ error: "max 25 candidates per request" });
      }

      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      if (!active) {
        return res.status(409).json({
          error: "no_active_narrative",
          locale,
          friendlyMessage: t("candidates.no_active_narrative", locale),
        });
      }

      const narrativeThemes = (active.themes || [])
        .map((t) => (typeof t === "string" ? t : t?.theme))
        .filter(Boolean)
        .map((t) => String(t).toLowerCase());
      const narrativeBuckets = new Set((active.majorBuckets || []).map(String));
      const declaredMajorBucket = majorInterest ? matchMajorBucketFn(majorInterest) : null;
      if (declaredMajorBucket) narrativeBuckets.add(declaredMajorBucket);

      const ranked = candidates.map((raw, idx) => {
        const name = String(raw?.name || "").trim();
        const description = String(raw?.description || "").trim();
        const combined = `${name} ${description}`.toLowerCase();
        if (!name) {
          return { ok: false, index: idx, error: t("candidates.name_required", locale) };
        }

        // 1. Major bucket match — did the candidate's text land in one of
        //    the narrative's detected buckets?
        const candidateBucket = matchMajorBucketFn(combined);
        const bucketHit = candidateBucket && narrativeBuckets.has(candidateBucket);

        // 2. Theme co-occurrence — count how many narrative themes appear in
        //    the candidate's text. Weight unigrams at 1, bigrams at 2.
        let themeHits = 0;
        const matchedThemes = [];
        for (const theme of narrativeThemes) {
          if (theme.length < 4) continue;
          if (combined.includes(theme)) {
            themeHits += theme.includes(" ") ? 2 : 1;
            matchedThemes.push(theme);
            if (matchedThemes.length >= 8) break;
          }
        }

        // 3. Predicted narrative_fit in [0, 1] — a friendly linear model.
        const predictedNarrativeFit = Math.min(
          1,
          (bucketHit ? 0.5 : 0) + Math.min(0.5, themeHits * 0.08),
        );

        // 4. Predicted tier — an EC that would land tier_2+ needs at least
        //    both a bucket match and some theme overlap.
        let predictedTier = "tier_4_foundational";
        if (bucketHit && themeHits >= 3) predictedTier = "tier_2_strong";
        else if (bucketHit || themeHits >= 4) predictedTier = "tier_3_developing";

        // Friendly summary — route through i18n so Korean students read Korean.
        const prettyBucket = (candidateBucket || "").replace(/_/g, " ");
        const themesList = matchedThemes.slice(0, 3).join(", ");
        let summaryKey;
        let summaryParams = {};
        if (bucketHit && themeHits >= 2) {
          summaryKey = "candidates.summary_strong";
          summaryParams = { bucket: prettyBucket, themes: themesList, fit: predictedNarrativeFit.toFixed(2) };
        } else if (bucketHit) {
          summaryKey = "candidates.summary_major_hit";
          summaryParams = { bucket: prettyBucket };
        } else if (themeHits > 0) {
          summaryKey = "candidates.summary_partial";
          summaryParams = { themes: themesList };
        } else {
          summaryKey = "candidates.summary_weak";
        }

        return {
          ok: true,
          index: idx,
          name,
          description: description || null,
          candidateBucket: candidateBucket || null,
          bucketHit,
          matchedThemes,
          themeHits,
          predictedNarrativeFit: Math.round(predictedNarrativeFit * 100) / 100,
          predictedTier,
          friendly: {
            tier: renderFriendlyTier(predictedTier),
            narrativeFit: renderFriendlyFactor("narrative_fit"),
            summary: t(summaryKey, locale, summaryParams),
            summaryKey,
          },
        };
      });

      // Sort descending by predicted fit so the student can see the top picks first.
      ranked.sort((a, b) => (b.predictedNarrativeFit ?? 0) - (a.predictedNarrativeFit ?? 0));

      // ── Budgeted semantic re-rank (best-effort) ──
      // The deterministic pass above is brittle (literal keyword overlap). When
      // OpenRouter is configured, ask the LLM to judge each idea's true fit to
      // the narrative/profile/target schools using supplied evidence, then merge
      // those scores and rationales over the baseline. Any failure keeps the
      // deterministic result.
      let engine = "deterministic";
      let rerankNote = null;
      const targetSchools = deps.resolveTargetSchools(req.studentId, req.body?.targetSchools);
      try {
        const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId);
        if (modelConfig && callLLM) {
          // The re-rank is bounded: a slow or stalled provider call used to hold
          // the whole response (the adapter allows ~105 s), and the student saw
          // "Ranking…" with no result for the entire wait. Past the budget the
          // deterministic ranking goes back with a note; the model call finishes
          // in the background and is simply discarded.
          const budgetMs = Number(process.env.EC_RERANK_TIMEOUT_MS) > 0 ? Number(process.env.EC_RERANK_TIMEOUT_MS) : 30_000;
          let timer = null;
          const llm = await Promise.race([
            deps.llmRankCandidates({ callLLM, modelConfig, studentId: req.studentId, active, candidates, targetSchools })
              .catch((e) => { console.warn("[EC candidates rank] LLM re-rank failed, using deterministic:", e.message); return null; }),
            new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), budgetMs); timer.unref?.(); }),
          ]);
          if (timer) clearTimeout(timer);
          if (llm === "timeout") {
            rerankNote = t("candidates.rerank_timeout", locale);
            console.warn(`[EC candidates rank] LLM re-rank exceeded ${budgetMs} ms, returning deterministic ranking`);
          }
          if (Array.isArray(llm) && llm.length) {
            const byName = new Map(llm.map((x) => [x.name.toLowerCase(), x]));
            for (const row of ranked) {
              if (!row.ok) continue;
              const m = byName.get(String(row.name).toLowerCase());
              if (!m) continue;
              row.predictedNarrativeFit = Math.round(m.fit * 100) / 100;
              if (m.tier) row.predictedTier = m.tier;
              row.friendly = {
                ...row.friendly,
                tier: renderFriendlyTier(row.predictedTier),
                summary: m.prestigeNote ? `${m.rationale} ${m.prestigeNote}`.trim() : (m.rationale || row.friendly?.summary),
              };
              if (m.sources?.length) row.sources = m.sources;
              row.engine = "llm";
            }
            ranked.sort((a, b) => (b.predictedNarrativeFit ?? 0) - (a.predictedNarrativeFit ?? 0));
            engine = "llm";
          }
        }
      } catch (e) {
        console.warn("[EC candidates rank] LLM re-rank failed, using deterministic:", e.message);
      }

      res.json({
        ok: true,
        engine,
        rerankNote,
        narrativeId: active.id,
        narrativeHash: active.hash,
        narrativeBuckets: [...narrativeBuckets],
        targetSchools,
        candidates: ranked,
        count: ranked.length,
        locale,
      });
    } catch (err) {
      console.error("[EC candidates rank] error:", err.message);
      res.status(500).json({ error: "Candidate ranking failed" });
    }
  });

  // POST /api/ec/ideas/generate — brainstorm NEW EC ideas grounded ONLY in the
  // student's real profile (courses, ECs, scores, major, goals, narrative).
  // Honors SKILL.md: suggestions framed as "you might consider", never invents
  // awards/prestige. Each idea is tagged with deterministic narrative fit.
  app.post("/api/ec/ideas/generate", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const locale = resolveLocale(req);
      const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId);
      if (!modelConfig) return res.status(503).json({ error: "The administrator must configure OpenRouter first." });
      const profile = deps.assembleProfileForGeneration(req.studentId);
      if (!profile) return res.status(404).json({ error: "No profile data. Complete your profile first." });
      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      const count = Math.min(8, Math.max(3, parseInt(req.body?.count, 10) || 5));
      const targetSchools = deps.resolveTargetSchools(req.studentId, req.body?.targetSchools);
      const priorities = await deps.getSchoolPriorities(targetSchools);
      const schoolBlock = deps.schoolPrioritiesPromptBlock(priorities);

      const summary = deps.profileSummaryForPrompt(profile, active);
      // Inject a random group of ten reference exemplars (Crimson set) as
      // calibration — real strong-EC patterns the model can gauge depth against
      // without copying. Reshuffled each call so suggestions stay varied.
      const exemplarBlock = exemplarsPromptBlock(randomExemplarGroup(10));
      const prompt = `STUDENT PROFILE (their real data — the ONLY basis for your ideas):
  ${summary}${schoolBlock}${exemplarBlock}

  TASK: Suggest ${count} extracurricular activity IDEAS this student could realistically pursue to strengthen their application${targetSchools.length ? " for the target schools above" : ""}. Ground EVERY idea in the profile above — connect each to a course, an existing activity, a test/AP strength, the intended major, or a stated goal.

  RULES:
  - Build on what the student already does (depth over breadth). Prefer deepening or extending existing activities and a coherent "spike" over scattered new clubs.${targetSchools.length ? "\n- Favor ideas that strengthen fit for what the target schools value above, but only where it fits the student's genuine direction." : ""}
  - Include at least one idea that builds community & character (service, mentorship, inclusivity, or authentic community impact) where it grows naturally out of something the student already cares about — never as résumé-padding.
  - Use the REFERENCE examples only to calibrate what "strong" looks like (depth, leadership, real impact). Do NOT copy them or assume the student has done them.
  - NEVER claim the student has won an award, held a title, or done something not in the profile.
  - Each idea must be something the student does themselves; frame as a suggestion to consider. These are activity ideas the student carries out and later writes about in their OWN words — never draft the essay or the story for them.

  Return ONLY a JSON array of exactly ${count} objects, no prose, no markdown:
  [
    {
      "name": "<short activity name>",
      "category": "<research|service|leadership|competition|creative|work|club|project|community|other>",
      "rationale": "<1-2 sentences tying this to the student's specific evidence above>",
      "dimension": "<which strength it builds: leadership|achievement|dedication|major_spike|prestige|narrative_fit|community_and_character>",
      "hoursPerWeekEstimate": <integer>
    }
  ]`;

      const resp = await callLLM({
        model: modelConfig.models?.medium || modelConfig.models?.large,
        max_tokens: 2000,
        system: "You are a college counselor brainstorming extracurricular ideas grounded ONLY in the student's real profile. Never invent awards or accomplishments. Output ONLY the requested JSON.",
        messages: [{ role: "user", content: prompt }],
      });
      const text = (resp?.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      const parsed = deps.parseLLMJson(text);
      const rawIdeas = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.ideas) ? parsed.ideas : []);
      const ideas = rawIdeas.slice(0, count).map((it) => {
        const name = String(it?.name || "").slice(0, 120);
        const category = String(it?.category || "other").slice(0, 40);
        const rationale = String(it?.rationale || "").slice(0, 400);
        const dimension = String(it?.dimension || "").slice(0, 40);
        const hours = Number.isFinite(Number(it?.hoursPerWeekEstimate)) ? Math.max(0, Math.min(40, Math.round(Number(it.hoursPerWeekEstimate)))) : null;
        const tag = deps.tagIdeaWithNarrative(`${name} ${rationale}`, active);
        return {
          name, category, rationale, dimension,
          hoursPerWeekEstimate: hours,
          ...tag,
          friendly: tag.predictedTier ? { tier: renderFriendlyTier(tag.predictedTier) } : null,
        };
      }).filter(it => it.name);

      res.json({ ok: true, ideas, count: ideas.length, hasNarrative: Boolean(active), targetSchools, locale });
    } catch (err) {
      if (Number.isInteger(err?.status) || err?.code) return deps.respondLLMError(res, err, "EC ideas generate");
      console.error("[EC ideas generate] error:", err.message);
      res.status(500).json({ error: "Idea generation failed" });
    }
  });

  // GET /api/ec/strength — list 5-factor strength vectors for this student
  // When ?friendly=1, each vector is decorated with human-readable labels
  // (tier, prestige source, factors). Jiyeon UX audit F11.
  app.get("/api/ec/strength", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const locale = resolveLocale(req);
      const rows = deps.ragStmts.strength.getByStudent.all(req.studentId) || [];
      const wantFriendly = req.query.friendly === "1" || req.query.friendly === "true";
      const vectors = rows
        .map((row) => {
          const v = toStrengthPublicShape(row);
          if (!v || !wantFriendly) return v;
          return enrichECVectorWithFriendly(v, deps.prestigeExplanationFor(row, v.ecName));
        })
        .filter(Boolean);
      // When the caller wants friendly labels, also ship a locale-aware legend
      // so the frontend can key off `friendlyLegendI18n[tier]` without
      // maintaining its own Korean copy.
      const localizedLegend = wantFriendly ? localizeFriendlyLabels(locale) : null;
      res.json({
        count: rows.length,
        factors: STRENGTH_FACTORS,
        tiers: Object.values(TIERS),
        vectors,
        locale,
        ...(wantFriendly
          ? {
              friendlyLegend: {
                tiers: TIER_FRIENDLY,
                prestigeSources: PRESTIGE_SOURCE_FRIENDLY,
                factors: FACTOR_FRIENDLY,
              },
              friendlyLegendI18n: localizedLegend,
            }
          : {}),
      });
    } catch (err) {
      console.error("[EC strength] list error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // GET /api/ec/strength/:ecName — single EC with reasoning + file refs.
  // Always includes the friendly label block and (when cached) the prestige
  // explanation — this is the page the student will actually stare at while
  // deciding whether to keep, deepen, or drop an EC.
  app.get("/api/ec/strength/:ecName", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const row = deps.ragStmts.strength.getByStudentAndName.get(req.studentId, req.params.ecName);
      if (!row) return res.status(404).json({ error: "No strength vector for this EC" });
      const fileRefIds = deps.safeParseJSON(row.file_refs_json, []);
      const attachments = fileRefIds
        .map((id) => deps.ragStmts.strength.getAttachmentById.get(id))
        .filter(Boolean)
        .map((a) => ({
          id: a.id,
          ec_name: a.ec_name,
          filename: a.filename,
          mime_type: a.mime_type,
          extracted_chars: a.extracted_chars,
          status: a.extraction_status,
          uploaded_at: a.uploaded_at,
          // Where the evidence came from: a file attached in chat, or a
          // direct upload.
          origin: String(a.storage_path || "").startsWith("chat://") ? "chat" : "upload",
        }));
      const baseVector = toStrengthPublicShape(row);
      const explanation = deps.prestigeExplanationFor(row, req.params.ecName);
      const enriched = enrichECVectorWithFriendly(baseVector, explanation);
      res.json({
        ok: true,
        vector: enriched,
        reasoning: deps.safeParseJSON(row.reasoning_json, null),
        attachments,
      });
    } catch (err) {
      console.error("[EC strength] get error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // GET /api/ec/strength/:ecName/prestige — student-facing prestige rationale.
  // Returns {score, source, rationale, sourcesCited, friendly, fetchedAt}. This
  // is the UX-audit F5 surface — the student can see WHY their EC scored what
  // it did, which reputable sources grounded the score, and when the backend
  // last looked. 404 if the EC doesn't belong to this student or hasn't been
  // researched yet.
  app.get("/api/ec/strength/:ecName/prestige", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const locale = resolveLocale(req);
      const row = deps.ragStmts.strength.getByStudentAndName.get(req.studentId, req.params.ecName);
      if (!row) {
        return res.status(404).json({
          error: "ec_not_found",
          ecName: req.params.ecName,
          locale,
          friendlyMessage: t("prestige.ec_not_found", locale),
          recomputeUrl: null,
        });
      }
      const explanation = deps.prestigeExplanationFor(row, req.params.ecName);
      if (!explanation) {
        const currentSource = row.prestige_source || "legacy";
        // Pull locale-specific short/summary from i18n when available, else
        // fall back to the engineer-shape renderer.
        const localizedSource = {
          short: t(`friendly.prestige.${currentSource}.short`, locale),
          summary: t(`friendly.prestige.${currentSource}.summary`, locale),
        };
        const friendly = localizedSource.short && localizedSource.summary
          ? localizedSource
          : renderFriendlyPrestigeSource(currentSource);
        return res.status(404).json({
          error: "no_cached_rationale",
          ecName: req.params.ecName,
          currentScore: row.prestige ?? 0,
          currentSource,
          friendly,
          locale,
          friendlyMessage: t("prestige.no_cached_rationale", locale, {
            short: friendly.short,
            summary: friendly.summary,
          }),
          recomputeUrl: `/api/ec/strength/recompute`,
          recomputeBody: { ec_name: req.params.ecName },
        });
      }
      const friendly = {
        short: t(`friendly.prestige.${explanation.source}.short`, locale) || renderFriendlyPrestigeSource(explanation.source).short,
        summary: t(`friendly.prestige.${explanation.source}.summary`, locale) || renderFriendlyPrestigeSource(explanation.source).summary,
      };
      res.json({
        ok: true,
        ecName: req.params.ecName,
        ...explanation,
        friendly,
        locale,
        recomputeUrl: `/api/ec/strength/recompute`,
        recomputeBody: { ec_name: req.params.ecName },
      });
    } catch (err) {
      console.error("[EC prestige] get rationale error:", err.message);
      res.status(500).json({ error: "Fetch failed" });
    }
  });

  // POST /api/ec/evidence/from-chat — read the files attached in past chat
  // turns into the activities they concern: the backfill for records stored
  // before chat uploads counted as EC evidence, and the student's own "read
  // my uploads" button. Returns what was linked, what named no activity, what
  // was already stored, and the uploads whose text is not in their chat
  // record (a PDF or image sent before this build kept only its name) so the
  // student can attach them again. Recomputes the strength vectors when
  // anything was linked, so the reply reflects the new evidence.
  app.post("/api/ec/evidence/from-chat", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const profile = deps.assembleProfileForGeneration(req.studentId);
      const summary = harvestStudentChatRecords(deps.ragStmts, req.studentId, {
        activities: profile?.activities || [],
        seal: chatHistory.sealText,
      });
      let recomputed = false;
      if (summary.linked.length) {
        await deps.recomputeStrengthForStudent(req.studentId);
        recomputed = true;
      }
      res.json({ ok: true, ...summary, recomputed });
    } catch (err) {
      console.error("[EC evidence] backfill error:", err.message);
      res.status(500).json({ error: "Could not read the chat uploads" });
    }
  });

  // POST /api/ec/strength/recompute — force a refresh of 4-factor vectors.
  // Body `{ ec_name?: string }` runs only a single EC if provided; else
  // recomputes every EC for the student.
  app.post("/api/ec/strength/recompute", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      if (!snap) return res.status(404).json({ error: "No profile data" });
      let activities = deps.safeParseJSON(snap.activities_json, []);
      const { ec_name } = req.body || {};
      if (ec_name) {
        activities = activities.filter((a) => a?.name === ec_name);
        if (activities.length === 0) {
          return res.status(404).json({ error: `No EC named ${ec_name}` });
        }
      }
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
      res.json({ ok: true, ...result, recomputedAt: new Date().toISOString() });
    } catch (err) {
      console.error("[EC strength] recompute error:", err.message);
      res.status(500).json({ error: "Recompute failed" });
    }
  });

  // POST /api/ec/strength/override — pin one or more factor values for an EC.
  // Overrides survive subsequent recomputes; tier is recalculated from the
  // merged vector.
  app.post("/api/ec/strength/override", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { ec_name, factor, value, overrides } = req.body || {};
      if (!ec_name) return res.status(400).json({ error: "ec_name required" });

      // Support either single {factor,value} or batched {overrides: {...}}
      let payload = {};
      if (overrides && typeof overrides === "object") {
        for (const k of STRENGTH_FACTORS) {
          if (overrides[k] !== undefined) payload[k] = Number(overrides[k]);
        }
      } else if (factor && value !== undefined) {
        if (!STRENGTH_FACTORS.includes(factor)) {
          return res.status(400).json({ error: `factor must be one of: ${STRENGTH_FACTORS.join(", ")}` });
        }
        payload[factor] = Number(value);
      } else {
        return res.status(400).json({ error: "Provide either {factor,value} or {overrides:{...}}" });
      }

      for (const [k, v] of Object.entries(payload)) {
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          return res.status(400).json({ error: `${k} must be a number in [0,1]` });
        }
      }

      const result = applyStrengthOverride(deps.ragStmts.strength, req.studentId, ec_name, payload);
      res.json({
        ok: true,
        ec_name,
        factors: result.factors,
        tier_label: result.tier_label,
        overrides: result.overrideJson,
      });
    } catch (err) {
      if (/No strength vector/i.test(err.message)) {
        return res.status(404).json({ error: err.message });
      }
      console.error("[EC strength] override error:", err.message);
      res.status(500).json({ error: "Override failed" });
    }
  });

  app.get("/api/ec/spike", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const locale = resolveLocale(req);
      const rows = deps.ragStmts.strength.getByStudent.all(req.studentId) || [];
      const rowByName = new Map(rows.map((r) => [r.ec_name, r]));
      const vectors = rows
        .map(toStrengthPublicShape)
        .filter(Boolean)
        .map((v) => {
          const explanation = deps.prestigeExplanationFor(rowByName.get(v.ecName), v.ecName);
          const enriched = enrichECVectorWithFriendly(v, explanation);
          // Composite ranking score from fields already on the row. Tier is the
          // dominant signal (it already folds in dedication/achievement/
          // leadership/prestige); major_spike and narrative_fit break ties
          // toward activities that actually lead the student's story.
          const tierWeight = deps.SPIKE_TIER_WEIGHT[v.tierLabel] ?? 1;
          const spike = Number(v.factors?.major_spike ?? 0);
          const fit = Number(v.factors?.narrative_fit ?? 0);
          // Scaled to 0–1 (the tier weight alone runs to 4, so the raw
          // composite topped out at 2.5 and the card showed "Lead score 1.34").
          const rankScore = (tierWeight * 0.5 + spike * 0.35 + fit * 0.15) / (4 * 0.5 + 0.35 + 0.15);
          return { ...enriched, rankScore: Math.round(rankScore * 1000) / 1000 };
        })
        .sort((a, b) => b.rankScore - a.rankScore);

      // Leading = top 2-3 (cap at 3, but only those that clear foundational).
      const leadingPool = vectors.filter((v) => v.tierLabel !== "tier_4_foundational");
      let leading = (leadingPool.length >= 2 ? leadingPool : vectors).slice(0, 3);
      let leadingNames = new Set(leading.map((v) => v.ecName));
      let supporting = vectors.filter((v) => !leadingNames.has(v.ecName));

      // ── Budgeted semantic re-rank (best-effort) ──
      // Reorder lead vs supporting by genuine narrative/major/target-school fit
      // using supplied evidence, attaching a one-line rationale. Falls back to
      // the deterministic composite on any failure.
      let engine = "deterministic";
      const targetSchools = deps.resolveTargetSchools(req.studentId, (() => {
        const q = req.query.targetSchools;
        if (!q) return null;
        return Array.isArray(q) ? q : String(q).split(",").map((s) => s.trim()).filter(Boolean);
      })());
      if (vectors.length > 0) {
        try {
          const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId);
          if (modelConfig && callLLM) {
            const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
            const llm = await deps.llmRankSpike({ callLLM, modelConfig, studentId: req.studentId, active, vectors, targetSchools });
            if (Array.isArray(llm) && llm.length) {
              const byName = new Map(llm.map((x) => [x.name.toLowerCase(), x]));
              for (const v of vectors) {
                const m = byName.get(String(v.ecName).toLowerCase());
                if (m) { v.leadRationale = m.rationale; if (m.sources?.length) v.sources = m.sources; v.leadScore = m.leadScore; }
              }
              // Leaders = LLM-flagged leads (cap 3), highest leadScore first;
              // top up from composite order if the LLM flagged fewer than 2.
              const flagged = vectors
                .filter((v) => byName.get(String(v.ecName).toLowerCase())?.lead)
                .sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
              let newLeading = flagged.slice(0, 3);
              if (newLeading.length < 2) {
                for (const v of vectors) {
                  if (newLeading.length >= 2) break;
                  if (!newLeading.includes(v)) newLeading.push(v);
                }
              }
              leading = newLeading;
              leadingNames = new Set(leading.map((v) => v.ecName));
              supporting = vectors.filter((v) => !leadingNames.has(v.ecName));
              engine = "llm";
            }
          }
        } catch (e) {
          console.warn("[EC spike] LLM re-rank failed, using deterministic:", e.message);
        }
      }

      // Wellbeing guardrail: sum weekly hours across ECs against the
      // sustainable ceiling encoded in ec-vectorizer.js. Duty-of-care AND
      // differentiator — we optimize for the student, not a longer list.
      const totalWeeklyHours = rows.reduce(
        (sum, r) => sum + (Number(r.hours_per_week) || 0),
        0,
      );
      const overCommitted = totalWeeklyHours >= WELLBEING_LIMITS.caution_weekly_hours;
      const wellbeing = {
        totalWeeklyHours: Math.round(totalWeeklyHours * 10) / 10,
        sustainableCap: WELLBEING_LIMITS.sustainable_weekly_hours,
        cautionLine: WELLBEING_LIMITS.caution_weekly_hours,
        hardCeiling: WELLBEING_LIMITS.hard_ceiling_weekly_hours,
        overCommitted,
        message: overCommitted
          ? `You're at ${Math.round(totalWeeklyHours)} hrs/week across your activities — above the ${WELLBEING_LIMITS.caution_weekly_hours}-hr caution line. Before adding anything, consider deepening your leading activities and easing off the supporting ones.`
          : `You're at ${Math.round(totalWeeklyHours)} hrs/week across your activities, within a sustainable range (up to ${WELLBEING_LIMITS.sustainable_weekly_hours} hrs/week).`,
      };

      const localizedLegend = localizeFriendlyLabels(locale);
      res.json({
        ok: true,
        count: rows.length,
        engine,
        targetSchools,
        leading,
        supporting,
        wellbeing,
        factors: STRENGTH_FACTORS,
        tiers: Object.values(TIERS),
        locale,
        friendlyLegend: {
          tiers: TIER_FRIENDLY,
          prestigeSources: PRESTIGE_SOURCE_FRIENDLY,
          factors: FACTOR_FRIENDLY,
        },
        friendlyLegendI18n: localizedLegend,
      });
    } catch (err) {
      console.error("[EC spike] error:", err.message);
      res.status(500).json({ error: "Spike analysis failed" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // EC PRESTIGE ENDPOINTS (counselor-gated)
  // ═══════════════════════════════════════════════════════════

  // GET /api/ec/prestige/:activityName — debug read of the cached prestige
  // row for a named activity. Does NOT trigger a web_search; returns 404 if
  // the activity has never been researched. Counselor-auth-gated because
  // the cache is shared across all students and so is not PII-scoped.
  // POST /api/ec/competitions/search - official-source prestige lookup tool.
  // Body accepts either `{ query, levelHint? }` or `{ activities: [{ name,
  // levelHint? }] }`. With cacheResults=true (default), each item is written
  // into the shared RAG prestige cache via researchCompetitionPrestige().
  app.post("/api/ec/competitions/search", deps.requireCounselorAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const cacheResults = body.cacheResults !== false;
      const levelHint = typeof body.levelHint === "string" ? body.levelHint.trim() : null;
      const studentId = typeof body.studentId === "string" ? body.studentId.trim() : null;

      let items = [];
      if (Array.isArray(body.activities)) {
        items = body.activities
          .map((a) => ({
            name: String(a?.name || a?.activityName || "").trim(),
            levelHint: String(a?.levelHint || levelHint || "").trim() || null,
          }))
          .filter((a) => a.name);
      } else if (Array.isArray(body.activityNames)) {
        items = body.activityNames
          .map((name) => ({ name: String(name || "").trim(), levelHint }))
          .filter((a) => a.name);
      } else if (body.query) {
        items = [{ name: String(body.query || "").trim(), levelHint }];
      }

      if (items.length === 0) {
        return res.status(400).json({
          error: "Provide query, activityNames[], or activities[].",
        });
      }
      if (items.length > 50) {
        return res.status(400).json({ error: "At most 50 activities per request." });
      }

      const prestigeAdapter = studentId ? deps.resolvePrestigeAdapter(studentId) : null;
      const results = [];
      for (const item of items) {
        const matches = searchCompetitionCatalog(item.name, {
          levelHint: item.levelHint,
          limit: Number(body.limit || 5),
        });
        let cachedResult = null;
        if (cacheResults) {
          cachedResult = await researchCompetitionPrestige({
            activityName: item.name,
            levelHint: item.levelHint || matches[0]?.level || null,
            stmts: deps.ragStmts,
            adapter: prestigeAdapter,
          });
        }
        results.push({
          query: item.name,
          levelHint: item.levelHint,
          matches,
          cachedResult,
        });
      }

      res.json({
        ok: true,
        count: results.length,
        cacheResults,
        catalogCount: OFFICIAL_COMPETITION_SOURCES.length,
        reputableDomains: REPUTABLE_DOMAINS,
        results,
      });
    } catch (err) {
      console.error("[EC competitions] search error:", err.message);
      res.status(500).json({ error: "Competition search failed" });
    }
  });

  // GET /api/ec/cache-memory — bulk read of the shared EC prestige cache plus
  // the five-factor component cache, so EC agents can consume cache memory
  // "all at once" without retriggering research or recompute.
  app.get("/api/ec/cache-memory", deps.requireCounselorAuth, (req, res) => {
    try {
      const limit = Math.max(1, Math.min(250, Number(req.query.limit || 25)));
      const factorQuery = typeof req.query.factor === "string" ? req.query.factor.trim() : "";
      const factor = factorQuery || null;
      const includeFailed = String(req.query.includeFailed || "").toLowerCase() === "true";

      if (factor && !STRENGTH_FACTORS.includes(factor)) {
        return res.status(400).json({
          error: `factor must be one of: ${STRENGTH_FACTORS.join(", ")}`,
        });
      }

      const prestigeTotal = Number(deps.ragStmts.countPrestigeCache?.get()?.total || 0);
      const componentTotal = Number(deps.ragStmts.countComponentCache?.get()?.total || 0);
      let prestigeRows = deps.ragStmts.listPrestigeCacheRecent?.all(limit * 4) || [];
      if (!includeFailed) {
        prestigeRows = prestigeRows.filter((row) => row?.source !== "research_failed");
      }
      prestigeRows = prestigeRows.slice(0, limit);

      const selectedFactors = factor ? [factor] : STRENGTH_FACTORS;
      const rowsByFactor = {};
      for (const factorName of selectedFactors) {
        const rows = deps.ragStmts.listComponentCacheRecentByFactor?.all(factorName, limit) || [];
        rowsByFactor[factorName] = rows.map((row) => ({
          cacheKey: row.cache_key,
          factor: row.factor,
          score: Number(row.score) || 0,
          source: row.source || null,
          provider: row.provider || null,
          model: row.model || null,
          reasoning: deps.safeJSON(row.reasoning_json, null),
          computedAt: row.created_at || null,
        }));
      }

      res.json({
        ok: true,
        limit,
        includeFailed,
        prestige: {
          ttlDays: PRESTIGE_TTL_DAYS,
          totalRows: prestigeTotal,
          returnedRows: prestigeRows.length,
          rows: prestigeRows.map((row) => {
            const ageMs = Date.now() - Date.parse(row.created_at || 0);
            const ageDays = Number.isFinite(ageMs) ? Math.floor(ageMs / 86_400_000) : null;
            return {
              cacheKey: row.cache_key,
              activityName: row.activity_name,
              normalizedName: normalizeActivityName(row.activity_name),
              levelHint: row.level_hint,
              score: Number(row.score) || 0,
              source: row.source || null,
              rationale: row.rationale || null,
              sourcesCited: deps.safeJSON(row.sources_json, []) || [],
              provider: row.provider || null,
              model: row.model || null,
              fetchedAt: row.created_at || null,
              ageDays,
              expired: ageDays != null && ageDays > PRESTIGE_TTL_DAYS,
            };
          }),
        },
        components: {
          factors: selectedFactors,
          totalRows: componentTotal,
          perFactorLimit: limit,
          rowsByFactor,
          countsByFactor: Object.fromEntries(
            selectedFactors.map((factorName) => [
              factorName,
              Number(deps.ragStmts.countComponentCacheByFactor?.get(factorName)?.total || 0),
            ]),
          ),
        },
      });
    } catch (err) {
      console.error("[EC cache-memory] get error:", err.message);
      res.status(500).json({ error: "EC cache memory lookup failed" });
    }
  });

  app.get("/api/ec/prestige/:activityName", deps.requireCounselorAuth, (req, res) => {
    try {
      const activityName = String(req.params.activityName || "").trim();
      if (!activityName) {
        return res.status(400).json({ error: "activityName path param required" });
      }
      const levelHint = typeof req.query.level === "string" ? req.query.level.trim() : null;

      // Prefer the exact (name, level) cache key; fall back to the latest
      // row for the name.
      const key = computePrestigeCacheKey(activityName, levelHint);
      let row = deps.ragStmts.getPrestigeCache.get(key);
      if (!row && !levelHint) {
        row = deps.ragStmts.getPrestigeCacheByName.get(activityName);
      }

      if (!row) {
        return res.status(404).json({
          error: "No cached prestige row for this activity.",
          activityName,
          normalizedName: normalizeActivityName(activityName),
          ttlDays: PRESTIGE_TTL_DAYS,
        });
      }

      const ageMs = Date.now() - Date.parse(row.created_at || 0);
      const ageDays = Number.isFinite(ageMs) ? Math.floor(ageMs / 86_400_000) : null;
      const expired = ageDays != null && ageDays > PRESTIGE_TTL_DAYS;

      res.json({
        ok: true,
        activityName: row.activity_name,
        levelHint: row.level_hint,
        score: Number(row.score) || 0,
        source: row.source || null,
        rationale: row.rationale || null,
        sourcesCited: deps.safeJSON(row.sources_json, []) || [],
        provider: row.provider || null,
        model: row.model || null,
        fetchedAt: row.created_at,
        ageDays,
        expired,
        ttlDays: PRESTIGE_TTL_DAYS,
      });
    } catch (err) {
      console.error("[EC prestige] get error:", err.message);
      res.status(500).json({ error: "Prestige lookup failed" });
    }
  });

  // POST /api/ec/prestige/recompute — force a fresh prestige research call.
  // Body `{ studentId: string, ecName?: string }`:
  //   • studentId required — identifies whose BYOK (if any) pays for the
  //     web_search call.
  //   • ecName optional — if provided, invalidates just that EC's prestige
  //     cache row(s); otherwise clears every EC's prestige cache for the
  //     student and re-runs.
  // After invalidation, re-invokes recomputeStudentECStrengthVectors so the
  // ec_strength_vectors table is rewritten with the fresh prestige.
  app.post("/api/ec/prestige/recompute", deps.requireCounselorAuth, async (req, res) => {
    try {
      const { studentId, ecName } = req.body || {};
      if (!studentId || typeof studentId !== "string") {
        return res.status(400).json({ error: "studentId required" });
      }

      const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
      if (!snap) return res.status(404).json({ error: "No profile snapshot for student" });

      let activities = deps.safeParseJSON(snap.activities_json, []);
      if (!Array.isArray(activities)) activities = [];

      if (ecName) {
        activities = activities.filter((a) => a?.name === ecName);
        if (activities.length === 0) {
          return res.status(404).json({ error: `No EC named "${ecName}" for this student` });
        }
      }

      // Invalidate prestige cache rows for the affected activities. We delete
      // by activity_name so every (name, level_hint) variant gets cleared.
      let invalidated = 0;
      for (const ec of activities) {
        if (!ec?.name) continue;
        try {
          const r = deps.ragStmts.deletePrestigeByName.run(ec.name);
          invalidated += r?.changes || 0;
        } catch {
          // Non-fatal.
        }
      }

      const active = getActiveNarrative(deps.ragStmts.narrative, studentId);
      const prestigeAdapter = deps.resolvePrestigeAdapter(studentId);
      const result = await recomputeStudentECStrengthVectors(
        deps.ragStmts.strength, studentId,
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
        studentId,
        ecName: ecName || null,
        invalidatedRows: invalidated,
        prestigeAvailable: !!prestigeAdapter,
        ...result,
        recomputedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[EC prestige] recompute error:", err.message);
      res.status(500).json({ error: "Prestige recompute failed" });
    }
  });

  // DELETE /api/ec/component-cache — admin reset for the five-factor
  // component cache. Body `{ factor: string, olderThanDays?: number }`.
  //   • factor required; one of STRENGTH_FACTORS.
  //   • olderThanDays optional — when provided, only rows older than that
  //     age are deleted (used for manual TTL enforcement); otherwise every
  //     row for the factor is cleared.
  app.delete("/api/ec/component-cache", deps.requireCounselorAuth, (req, res) => {
    try {
      const { factor, olderThanDays } = req.body || {};
      if (!factor || !STRENGTH_FACTORS.includes(factor)) {
        return res.status(400).json({
          error: `factor required; must be one of: ${STRENGTH_FACTORS.join(", ")}`,
        });
      }

      let changes = 0;
      if (olderThanDays !== undefined && olderThanDays !== null) {
        const days = Number(olderThanDays);
        if (!Number.isFinite(days) || days < 0) {
          return res.status(400).json({ error: "olderThanDays must be a non-negative number" });
        }
        // SQLite modifier: negative → subtract from 'now' in deleteComponentCacheOlderThan
        const modifier = `-${Math.floor(days)} days`;
        const r = deps.ragStmts.deleteComponentCacheOlderThan.run(factor, modifier);
        changes = r?.changes || 0;
      } else {
        const r = deps.ragStmts.deleteComponentCacheByFactor.run(factor);
        changes = r?.changes || 0;
      }

      res.json({
        ok: true,
        factor,
        olderThanDays: olderThanDays ?? null,
        deleted: changes,
      });
    } catch (err) {
      console.error("[EC component-cache] delete error:", err.message);
      res.status(500).json({ error: "Component cache delete failed" });
    }
  });
}
