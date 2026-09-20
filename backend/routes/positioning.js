// routes/positioning.js — the /api/positioning routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (SCORECARD_API_KEY, buildStudentCallLLM, collegeResearchStmts, piiStmts, ragStmts, rememberFitRead, requireStudentAuth, runPositioning, studentLimiter, withScorecardMeta).
import { validateRequiredConsents } from "../security/consent.js";
import { expandCollegeAlias, pickScorecardHit, readResearchCache, slugifyCollege } from "../colleges/college-research.js";
import { buildPositioningForTarget, buildStudentModel } from "../colleges/positioning-engine.js";
import { getActiveNarrative } from "../activities/narrative-store.js";
import { FIT_VERIFY_TTL_DAYS, verifyCollegeFit } from "../colleges/fit-verifier.js";
import { getCollegeById, searchScorecard } from "../colleges/college-scorecard.js";
import { readSchoolPolicyLive } from "../scouts/admissions-policy-scout.js";
import crypto from "node:crypto";

export function registerPositioningRoutes(app, deps) {
  app.post("/api/positioning/targets", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const { payload, cached } = await deps.runPositioning({ studentId: req.studentId, body: req.body || {} });
      res.json(deps.withScorecardMeta(payload, {
        cached,
        cacheKind: "positioning_targets",
        dataFreshness: "current",
      }));
    } catch (err) {
      if (Number.isInteger(err?.status) && err.status < 500) return res.status(err.status).json({ error: err.message });
      console.error("[POSITIONING] Error:", err.message);
      res.status(500).json({ error: "Target positioning failed" });
    }
  });

  // The College Fit double-check: re-verify the inputs behind a school's fit
  // read against the live web — College Scorecard (live IPEDS), the school's
  // own admissions pages read by the policy scout, and the same pages read by
  // the medium-tier model as a second, quote-verified reader — then re-score
  // with the live inputs when they differ. Cached per student and school for
  // a day; force: true re-runs it.
  app.post("/api/positioning/verify", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const schoolName = String(req.body?.schoolName || "").trim().slice(0, 120);
      if (!schoolName) return res.status(400).json({ error: "schoolName is required" });
      const consents = validateRequiredConsents(deps.piiStmts, req.studentId, "ai_interaction");
      if (!consents.allowed) {
        return res.status(403).json({ error: "AI consent is required before web verification.", code: "consent_required", missing: consents.missing });
      }
      const slug = slugifyCollege(expandCollegeAlias(schoolName));
      const cacheKey = "fitverify:" + req.studentId + ":" + slug;
      if (req.body?.force !== true) {
        const cached = readResearchCache(deps.collegeResearchStmts, cacheKey, FIT_VERIFY_TTL_DAYS);
        if (cached) return res.json({ ...cached, cached: true });
      }

      const run = await deps.runPositioning({
        studentId: req.studentId,
        body: { targets: [{ schoolName }], ...(req.body?.major ? { major: req.body.major } : {}) },
        bypassCache: true,
      });
      const target = run.payload?.targets?.[0];
      const internals = run.internals?.[0];
      if (!target || !internals) return res.status(404).json({ error: "No fit read is available for this school yet." });
      const { collegeContext, effectiveCds, options, website } = internals;
      const strengthRows = deps.ragStmts.strength.getByStudent.all(req.studentId);
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      const studentModel = buildStudentModel({
        gpa_unweighted: snap.gpa_unweighted, gpa_weighted: snap.gpa_weighted, courses_json: snap.courses_json,
        test_scores_json: snap.test_scores_json, ap_scores_json: snap.ap_scores_json, class_rank_json: snap.class_rank_json,
        activities_json: snap.activities_json, major_interest: run.payload.major || snap.major_interest,
      }, strengthRows, getActiveNarrative(deps.ragStmts.narrative, req.studentId));

      const used = {
        acceptanceRate: collegeContext.acceptanceRate ?? null,
        sat25: collegeContext.sat25 ?? null, sat75: collegeContext.sat75 ?? null,
        act25: collegeContext.act25 ?? null, act75: collegeContext.act75 ?? null,
        testPolicy: effectiveCds?.parsed?.testPolicy || null,
        testPolicySource: effectiveCds?.sourceLabel || effectiveCds?.source || null,
        source: collegeContext.source || null,
        cdsYear: internals.cdsYear,
      };
      const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId, { requestIdPrefix: "fit-verify:" + req.studentId });
      const verification = await verifyCollegeFit({
        school: { name: collegeContext.name, unitId: collegeContext.unitId || null, homepage: website },
        used,
        lookupScorecard: async ({ name, unitId }) => {
          if (!deps.SCORECARD_API_KEY) return null;
          if (unitId) return getCollegeById(deps.SCORECARD_API_KEY, unitId);
          const wanted = expandCollegeAlias(name);
          return pickScorecardHit((await searchScorecard(deps.SCORECARD_API_KEY, { name: wanted, limit: 20 }))?.results, wanted);
        },
        readPolicy: (t) => readSchoolPolicyLive(t, { scorecardKey: deps.SCORECARD_API_KEY || null }),
        callLLM: modelConfig && callLLM
          ? (args) => callLLM({ ...args, requestId: "fit-verify:" + req.studentId + ":" + crypto.randomUUID() })
          : null,
        model: modelConfig?.models?.medium,
        rescore: (live) => buildPositioningForTarget(
          studentModel,
          { ...collegeContext, acceptanceRate: live.acceptanceRate ?? collegeContext.acceptanceRate, sat25: live.sat25 ?? collegeContext.sat25, sat75: live.sat75 ?? collegeContext.sat75, act25: live.act25 ?? collegeContext.act25, act75: live.act75 ?? collegeContext.act75 },
          { ...(effectiveCds || {}), parsed: { ...(effectiveCds?.parsed || {}), testPolicy: live.testPolicy || effectiveCds?.parsed?.testPolicy || null } },
          options,
        ),
        original: target,
      });
      if (verification.modelReview && verification.modelReview.status !== "ok") {
        console.warn(`[POSITIONING/VERIFY] model review ${verification.modelReview.status} for ${collegeContext.name}:`, verification.modelReview.excerpt || verification.modelReview.error || "");
      }
      const payload = {
        ...verification,
        positioning: { overallPositioningLabel: target.overallPositioningLabel, finalPositioningScore: target.finalPositioningScore, dataProvenance: target.dataProvenance || null },
      };
      deps.collegeResearchStmts.put.run(cacheKey, "fitverify", slug, collegeContext.name, JSON.stringify(payload), new Date().toISOString());
      deps.rememberFitRead(req.studentId, target, { verification: payload });
      res.json({ ...payload, cached: false });
    } catch (err) {
      if (err?.status === 402 || err?.code === "budget_exceeded") {
        return res.status(402).json({ error: "The monthly AI budget doesn't allow this check right now.", code: err.code || "budget_exceeded" });
      }
      if (Number.isInteger(err?.status) && err.status < 500) return res.status(err.status).json({ error: err.message });
      console.error("[POSITIONING/VERIFY] Error:", err?.code || "", err?.message);
      res.status(500).json({ error: "College Fit double-check failed" });
    }
  });
}
