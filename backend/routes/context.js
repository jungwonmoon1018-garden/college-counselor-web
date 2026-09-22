// routes/context.js — the /api/context routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (assembleProfileForGeneration, prestigeExplanationFor, ragStmts, requireStudentAuth, studentLimiter).
import { localizeFriendlyLabels, resolveLocale } from "../shared/i18n.js";
import { assembleRAGContext } from "../storage/rag-engine.js";
import { STRENGTH_FACTORS, TIERS, toPublicShape as toStrengthPublicShape } from "../activities/ec-strength-vectorizer.js";
import { FACTOR_FRIENDLY, PRESTIGE_SOURCE_FRIENDLY, TIER_FRIENDLY, enrichECVectorWithFriendly, renderFriendlyDirectionalityFactor, renderFriendlyDirectionalityLabel } from "../activities/friendly-labels.js";
import { computeProfileFingerprint, getActiveNarrative } from "../activities/narrative-store.js";

export function registerContextRoutes(app, deps) {
  // GET /api/context/bundle — STUDENT CONTEXT BUNDLE
  // ═══════════════════════════════════════════════════════════
  // Collapses the four granular endpoints (/api/rag/context,
  // /api/ec/strength, /api/directionality, /api/ap-concepts/vectors) into a
  // single round-trip for current student views and internal orchestration.
  //
  // The returned shape remains stable at `version: "1.1"`.
  // Bumped from 1.0 when the EC strength vector gained a 5th factor ("prestige")
  // backed by competition-research.js.
  //
  // Every field is PII-screened: names → [STUDENT], emails → [EMAIL], raw
  // activity JSON is never included.
  app.get("/api/context/bundle", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const studentId = req.studentId;
      const locale = resolveLocale(req);

      // ── RAG context (numeric/categorical, [STUDENT]-placeheld) ──
      const focus = typeof req.query.focus === "string" ? req.query.focus : "holistic";
      const rag = assembleRAGContext(deps.ragStmts, studentId, focus);
      if (rag?.error) return res.status(404).json({ version: "1.1", error: rag.error, locale });

      // ── EC strength vectors ──
      // Friendly labels default ON — Jiyeon UX audit F11 feedback was that
      // an opt-in flag meant every forgotten caller leaked engineer strings
      // to the student. Callers that want the lean raw shape (the skill's
      // tokens-matter path) can pass ?raw=1 to opt out.
      const wantRaw =
        req.query.raw === "1" || req.query.raw === "true" || req.query.friendly === "0";
      const wantFriendly = !wantRaw;
      let ecStrength = null;
      try {
        const rows = deps.ragStmts.strength?.getByStudent?.all(studentId) || [];
        const vectors = rows
          .map((row) => {
            const v = toStrengthPublicShape(row);
            if (!v || !wantFriendly) return v;
            return enrichECVectorWithFriendly(v, deps.prestigeExplanationFor(row, v.ecName));
          })
          .filter(Boolean);
        ecStrength = {
          count: rows.length,
          factors: STRENGTH_FACTORS,
          tiers: Object.values(TIERS),
          vectors,
          ...(wantFriendly
            ? {
                friendlyLegend: {
                  tiers: TIER_FRIENDLY,
                  prestigeSources: PRESTIGE_SOURCE_FRIENDLY,
                  factors: FACTOR_FRIENDLY,
                },
              }
            : {}),
        };
      } catch (err) {
        console.warn("[context/bundle] EC strength fetch failed:", err.message);
        ecStrength = { count: 0, factors: STRENGTH_FACTORS, tiers: Object.values(TIERS), vectors: [], _warning: "fetch_failed" };
      }

      // ── AP concept vectors ──
      let apConcepts = null;
      try {
        const subjectVectors = deps.ragStmts.apConcepts?.getAllSubjectVectors?.all(studentId) || [];
        const studentConcepts = deps.ragStmts.apConcepts?.getAllStudentConcepts?.all(studentId) || [];
        const conceptsBySubject = new Map();
        for (const row of studentConcepts) {
          if (!conceptsBySubject.has(row.subject_id)) conceptsBySubject.set(row.subject_id, []);
          conceptsBySubject.get(row.subject_id).push({
            concept_id: row.concept_id,
            mastery: row.mastery,
            last_signal: row.last_signal,
            evidence_count: row.evidence_count,
            is_overridden: Boolean(row.is_overridden),
          });
        }
        apConcepts = {
          subjects: subjectVectors.map((v) => ({
            subject_id: v.subject_id,
            subject_vector: v.subject_vector,
            weighted_total: v.weighted_total,
            concept_count: v.concept_count,
            concepts: conceptsBySubject.get(v.subject_id) || [],
          })),
        };
      } catch (err) {
        console.warn("[context/bundle] AP concepts fetch failed:", err.message);
        apConcepts = { subjects: [], _warning: "fetch_failed" };
      }

      // ── Directionality vector ──
      let directionality = null;
      try {
        const dv = deps.ragStmts.directionality?.getByStudent?.get(studentId);
        if (dv) {
          directionality = {
            factors: {
              academic_momentum: dv.academic_momentum,
              test_score_strength: dv.test_score_strength,
              major_academic_fit: dv.major_academic_fit,
              rigor_and_challenge: dv.rigor_and_challenge,
              overall_academic_standing: dv.overall_academic_standing,
            },
            label: dv.directionality_label,
            computedAt: dv.computed_at,
            isOverridden: Boolean(dv.is_overridden),
            ...(wantFriendly
              ? {
                  friendly: {
                    label: renderFriendlyDirectionalityLabel(dv.directionality_label),
                    factors: {
                      academic_momentum: renderFriendlyDirectionalityFactor("academic_momentum"),
                      test_score_strength: renderFriendlyDirectionalityFactor("test_score_strength"),
                      major_academic_fit: renderFriendlyDirectionalityFactor("major_academic_fit"),
                      rigor_and_challenge: renderFriendlyDirectionalityFactor("rigor_and_challenge"),
                      overall_academic_standing: renderFriendlyDirectionalityFactor("overall_academic_standing"),
                    },
                  },
                }
              : {}),
          };
        }
      } catch (err) {
        console.warn("[context/bundle] directionality fetch failed:", err.message);
        directionality = { _warning: "fetch_failed" };
      }

      // ── Active narrative ─────────────────────────────────────────
      // By default we return themes + hash only (the skill can reason
      // symbolically). When the client opts in with ?narrativeText=1 AND the
      // request is from the student's own session, we include the full text
      // so the skill can quote it verbatim in coaching replies. The narrative
      // is the organizing primitive of the whole app — F2 from the Jiyeon UX
      // audit — so the student should be able to surface it on demand.
      let narrative = null;
      try {
        const includeText =
          req.query.narrativeText === "1" ||
          req.query.narrativeText === "true" ||
          req.query.include_narrative_text === "1";
        const active = getActiveNarrative(deps.ragStmts.narrative, studentId);
        if (active) {
          // Drift preview: is every ec_strength_vectors row tied to the current
          // narrative id? If not, flag it so the frontend can show a banner.
          // Cheap — no extra query beyond what we already read above.
          let staleCount = 0;
          try {
            const rows = deps.ragStmts.strength?.getByStudent?.all(studentId) || [];
            for (const row of rows) {
              if (!row.narrative_version_id || row.narrative_version_id !== active.id) staleCount += 1;
            }
          } catch { staleCount = 0; }
          // Profile staleness: does the narrative predate newly-added
          // ECs/courses? (EC-add ties new vectors to the CURRENT narrative id,
          // so narrative_version_id drift won't catch this — the fingerprint
          // does.) source tells the skill/UI whether it's auto-maintained.
          let profileStale = false;
          try {
            const prof = deps.assembleProfileForGeneration(studentId);
            if (prof && active.profileFingerprint) {
              profileStale = active.profileFingerprint !== computeProfileFingerprint(prof);
            }
          } catch { /* non-fatal */ }
          narrative = {
            active: {
              id: active.id,
              themes: active.themes || [],
              majorBuckets: active.majorBuckets || [],
              hash: active.hash || null,
              source: active.source || "student",
              updatedAt: active.updatedAt || null,
              ...(includeText && active.narrativeText
                ? { narrativeText: active.narrativeText }
                : {}),
              narrativeTextAvailable: Boolean(active.narrativeText),
              drift: { staleCount, hasStale: staleCount > 0 },
              profileStale,
            },
          };
        } else {
          narrative = { active: null };
        }
      } catch (err) {
        console.warn("[context/bundle] narrative fetch failed:", err.message);
        narrative = { active: null, _warning: "fetch_failed" };
      }

      // ── College history context (from cached Scorecard data) ──────────────
      // Read-only pull from scorecard_history. The background fetch (triggered
      // on sync) will have populated rows by the time the skill calls this.
      let collegeContext = null;
      try {
        // assembleRAGContext already embeds collegeContext — pull it from there
        // so we don't double-compute.
        if (rag?.collegeContext) {
          collegeContext = rag.collegeContext;
        }
      } catch (err) {
        console.warn("[context/bundle] college context fetch failed:", err.message);
      }

      // ── CDS positioning context — for each goal/target school the student
      // mentioned, surface the validated CDS record + freshness so the skill
      // can ground school-specific advice in real numbers and cite when the
      // validator overrode a parsed value. Only includes schools we have in
      // cds_records (others fall back to the existing collegeContext path).
      let cdsContext = null;
      try {
        const goalNames = (rag?.goalSchoolNames || rag?.targetSchools || []).slice(0, 12);
        if (goalNames.length > 0) {
          const { loadValidatedRecord, loadLatestValidation } = await import("../cds/cds-validator.js");
          const slugify = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
          const matches = [];
          for (const name of goalNames) {
            const slug = slugify(name);
            const rec = loadValidatedRecord(deps.ragStmts, slug);
            if (!rec) continue;
            const v = loadLatestValidation(deps.ragStmts, slug);
            // c7Weighted: for each labeled rating, surface the numeric weight
            // (1.0 / 0.7 / 0.35 / 0.0) so the AI doesn't have to re-derive it.
            // Lets the skill produce sentences like "Stanford weights essays
            // very_important (1.0) which is why your strong narrative matters
            // more here than at <other school>."
            const C7_WEIGHTS = { very_important: 1.00, important: 0.70, considered: 0.35, not_considered: 0.00 };
            const c7Weighted = {};
            for (const [k, label] of Object.entries(rec.c7 || {})) {
              c7Weighted[k] = { rating: label, weight: C7_WEIGHTS[label] ?? null };
            }

            matches.push({
              slug: rec.slug,
              school: rec.school,
              year: rec.year,
              tier: rec.tier,
              overallAdmitRate: rec.overallAdmitRate,
              yieldRate: rec.yieldRate,
              enrolledSAT: rec.enrolledSAT,
              enrolledACT: rec.enrolledACT,
              enrolledGPA: rec.enrolledGPA,
              testPolicy: rec.testPolicy,
              c7: rec.c7,
              c7Weighted,
              c1Breakdown: rec.c1Breakdown || null,
              sourceUrl: rec.sourceUrl,
              // Validation freshness — the skill uses this to caveat numbers.
              validation: v ? {
                status: v.status,
                corrections: Object.keys(v.overrides || {}),
                sources: v.sources || [],
                validatedAt: v.validatedAt,
              } : null,
            });
          }
          if (matches.length > 0) {
            cdsContext = {
              schoolsMatched: matches.length,
              requested: goalNames.length,
              schools: matches,
            };
          }
        }
      } catch (err) {
        console.warn("[context/bundle] cds context fetch failed:", err.message);
      }

      // Locale-aware legend — Korean skill sessions read a Korean legend so
      // the chat never has to translate "tier_3_developing" for the student.
      const friendlyLegendI18n = wantFriendly ? localizeFriendlyLabels(locale) : null;

      res.json({
        version: "1.2",  // bumped: cdsContext block added
        studentPlaceholder: "[STUDENT]",
        generatedAt: new Date().toISOString(),
        locale,
        rag,
        ecStrength,
        apConcepts,
        directionality,
        narrative,
        collegeContext,
        cdsContext,
        ...(friendlyLegendI18n ? { friendlyLegendI18n } : {}),
        tierHints: {
          small:  "OCR, extraction, validation, classification, narrative-fit scoring",
          medium: "synthesis, coaching, college list building, trend analysis",
          large:  "essay critique, cross-source conflict resolution, nuanced strategy",
        },
      });
    } catch (err) {
      console.error("[context/bundle] error:", err.message);
      res.status(500).json({ version: "1.1", error: "Context bundle assembly failed" });
    }
  });
}
