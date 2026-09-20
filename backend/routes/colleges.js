// routes/colleges.js — the /api/colleges routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (SCORECARD_API_KEY, assembleProfileForGeneration, buildBaselineCollegeSearchResponse, buildStudentCallLLM, collegeResearchStmts, db, fitMatrixOptions, getScorecardQueryCache, normalizeComparePayload, normalizeScorecardSearchPayload, normalizeUnitId, piiStmts, putScorecardQueryCache, ragStmts, requireStudentAuth, safeJSON, scorecardLimiter, studentLimiter, withScorecardMeta).
import { validateRequiredConsents } from "../security/consent.js";
import { buildValuesFromCds, expandCollegeAlias, researchCollegeValues } from "../colleges/college-research.js";
import { computeFit } from "../colleges/college-values.js";
import { resolveLocale } from "../shared/i18n.js";
import crypto from "node:crypto";
import { resolveStoredCdsRecord } from "../cds/cds-store.js";
import { compareColleges, getCollegeById, getCollegeHistory, getFinancialAidProfile, searchScorecard } from "../colleges/college-scorecard.js";
import { buildCollegeHistoryContext } from "../storage/rag-engine.js";

export function registerCollegesRoutes(app, deps) {
  // ═══════════════════════════════════════════════════════════
  // COLLEGE VALUES + FIT
  // ═══════════════════════════════════════════════════════════
  // Extract a college's stated values (cached 90d) and compute how the
  // student's courses + ECs map onto them. Historical model calls used the
  // administrator-configured OpenRouter credential and a fixed server model;
  // students cannot supply provider keys or model overrides.

  // POST /api/colleges/values — official-source values lookup, rebuilt at the
  // owner's request. Only pages on the school's own site (resolved via the
  // College Scorecard) are fetched; the model summarizes fetched text and every
  // quote is verified verbatim before serving. Results are cached (90 days) and
  // scored against the student's profile with the deterministic fit scorer.
  app.post("/api/colleges/values", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const { collegeName, hintUrl, force } = req.body || {};
      if (!collegeName || typeof collegeName !== "string") {
        return res.status(400).json({ error: "collegeName is required" });
      }
      const consents = validateRequiredConsents(deps.piiStmts, req.studentId, "ai_interaction");
      if (!consents.allowed) {
        return res.status(403).json({ error: "AI consent is required before web research.", code: "consent_required", missing: consents.missing });
      }
      const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId, { requestIdPrefix: "college-values:" + req.studentId });
      if (!modelConfig || !callLLM) {
        return res.status(503).json({ error: "AI research is not configured on this server.", code: "openrouter_not_configured" });
      }

      const result = await researchCollegeValues({
        collegeName: collegeName.slice(0, 120),
        hintUrl: typeof hintUrl === "string" ? hintUrl.slice(0, 300) : null,
        scorecardKey: deps.SCORECARD_API_KEY || null,
        callLLM: (args) => callLLM({ ...args, requestId: "college-values:" + req.studentId + ":" + crypto.randomUUID() }),
        model: modelConfig.models?.medium || undefined,
        stmts: deps.collegeResearchStmts,
        force: force === true,
      });

      const profile = deps.assembleProfileForGeneration(req.studentId);
      const fit = profile ? computeFit(result.values, profile, deps.fitMatrixOptions(req.studentId, result.displayName || collegeName)) : null;
      res.json({ ...result, fit, locale: resolveLocale(req) });
    } catch (err) {
      if (err?.code && err?.status === 404) {
        // Site blocked or unreadable → fall back to the school's Common Data
        // Set admission priorities (C7) when we hold a CDS record for it. The
        // fit scorer runs against those the same way it runs against quoted
        // values, and the card labels the provenance.
        if (["no_official_pages", "values_not_found", "school_site_not_found"].includes(err.code)) {
          try {
            const record = resolveStoredCdsRecord(deps.ragStmts, {
              schoolName: expandCollegeAlias(String(req.body?.collegeName || "")),
            });
            const cdsValues = record ? buildValuesFromCds(record) : null;
            if (cdsValues) {
              const profile = deps.assembleProfileForGeneration(req.studentId);
              const fit = profile ? computeFit(cdsValues.values, profile, deps.fitMatrixOptions(req.studentId, cdsValues.displayName)) : null;
              return res.json({ ...cdsValues, fit, cached: false, locale: resolveLocale(req) });
            }
          } catch (fallbackErr) {
            console.warn("[COLLEGE-VALUES] CDS fallback failed:", fallbackErr?.message);
          }
        }
        return res.status(404).json({ error: err.message, code: err.code });
      }
      if (err?.status === 402 || err?.code === "budget_exceeded") {
        return res.status(402).json({ error: "The monthly AI budget doesn't allow this lookup right now.", code: err.code || "budget_exceeded" });
      }
      console.error("[COLLEGE-VALUES] lookup failed:", err?.code || "", err?.message);
      res.status(502).json({ error: "College values lookup failed. Try again, or paste the school's mission-page URL as a hint.", code: err?.code || "research_failed" });
    }
  });

  // DELETE /api/colleges/values — clear the cached extractions so the next
  // lookup re-fetches (used when a cached extraction was wrong).
  app.delete("/api/colleges/values", deps.studentLimiter, deps.requireStudentAuth, (_req, res) => {
    try {
      const deleted = deps.collegeResearchStmts.clearKind.run("values").changes || 0;
      res.json({ deleted });
    } catch (err) {
      console.error("[COLLEGE-VALUES] cache clear failed:", err.message);
      res.status(500).json({ error: "Cache clear failed" });
    }
  });

  app.post("/api/colleges/search", deps.scorecardLimiter, async (req, res) => {
    try {
      const { name, state, states, minSAT, maxTuition, maxAcceptanceRate, sizePreference, limit, page } = req.body;
      const queryPayload = deps.normalizeScorecardSearchPayload({
        name, state, states, minSAT, maxTuition, maxAcceptanceRate, sizePreference, limit, page,
      });
      if (!deps.SCORECARD_API_KEY) {
        return res.json(deps.withScorecardMeta(deps.buildBaselineCollegeSearchResponse(queryPayload), {
          cached: false,
          stale: true,
          fallback: true,
          fallbackReason: "scorecard_not_configured",
          dataFreshness: "baseline",
        }));
      }
      const cached = deps.getScorecardQueryCache("search", queryPayload);
      if (cached?.data) {
        return res.json(deps.withScorecardMeta(cached.data, {
          cached: true,
          cacheKind: "search",
          dataFreshness: "current",
        }));
      }
      const result = await searchScorecard(deps.SCORECARD_API_KEY, queryPayload);
      if (result.error) {
        console.warn("[SCORECARD] Search error:", result.error);
        return res.json(deps.withScorecardMeta(deps.buildBaselineCollegeSearchResponse(queryPayload), {
          cached: false,
          stale: true,
          fallback: true,
          fallbackReason: "scorecard_live_error",
          dataFreshness: "baseline",
        }));
      }
      deps.putScorecardQueryCache("search", queryPayload, result);
      res.json(deps.withScorecardMeta(result, {
        cached: false,
        cacheKind: "search",
        dataFreshness: "current",
      }));
    } catch (err) {
      console.error("[SCORECARD] Search error:", err.message);
      res.status(500).json({ error: "College search failed" });
    }
  });

  app.get("/api/colleges/:id", deps.scorecardLimiter, async (req, res) => {
    try {
      const unitId = deps.normalizeUnitId(req.params.id);
      if (!unitId || unitId.length > 10) return res.status(400).json({ error: "Valid unit ID required" });

      let college = null;
      if (deps.SCORECARD_API_KEY) {
        const cached = deps.getScorecardQueryCache("college_by_id", { unitId });
        if (cached?.data) {
          return res.json(deps.withScorecardMeta(cached.data, {
            cached: true,
            cacheKind: "college_by_id",
            dataFreshness: "current",
          }));
        }
        college = await getCollegeById(deps.SCORECARD_API_KEY, unitId);
        if (college) deps.putScorecardQueryCache("college_by_id", { unitId }, college);
      }

      if (!college) {
        const baseline = deps.db.prepare("SELECT * FROM baseline_colleges WHERE unit_id = ?").get(unitId);
        if (!baseline) return res.status(404).json({ error: "College not found" });
        college = {
          unitId: baseline.unit_id, name: baseline.name, state: baseline.state,
          sat25: baseline.sat_25, sat75: baseline.sat_75, act25: baseline.act_25, act75: baseline.act_75,
          acceptanceRate: baseline.acceptance_rate != null ? Math.round(baseline.acceptance_rate * 1000) / 10 : null,
          enrollment: baseline.enrollment, tuitionIn: baseline.tuition_in, tuitionOut: baseline.tuition_out,
          avgGpaAdmitted: baseline.avg_gpa_admitted, gradRate: baseline.grad_rate_6yr,
          retentionRate: baseline.retention_rate, medianEarnings10yr: baseline.median_earnings_10yr,
          topMajors: deps.safeJSON(baseline.top_majors_json, []),
          apCoursesValued: deps.safeJSON(baseline.ap_courses_valued_json, []),
          ecEmphasis: deps.safeJSON(baseline.ec_emphasis_json, []),
          source: "Baseline data (NCES IPEDS)",
        };
        return res.json(deps.withScorecardMeta(college, {
          cached: false,
          stale: true,
          fallback: true,
          fallbackReason: deps.SCORECARD_API_KEY ? "scorecard_live_error_or_miss" : "scorecard_not_configured",
          dataFreshness: "baseline",
        }));
      }
      res.json(deps.withScorecardMeta(college, {
        cached: false,
        cacheKind: "college_by_id",
        dataFreshness: "current",
      }));
    } catch (err) {
      console.error("[SCORECARD] College lookup error:", err.message);
      res.status(500).json({ error: "College lookup failed" });
    }
  });

  app.get("/api/colleges/:id/financial-aid", deps.scorecardLimiter, async (req, res) => {
    try {
      const unitId = deps.normalizeUnitId(req.params.id);
      if (!unitId || unitId.length > 10) return res.status(400).json({ error: "Valid unit ID required" });

      if (!deps.SCORECARD_API_KEY) {
        const baseline = deps.db.prepare("SELECT * FROM baseline_colleges WHERE unit_id = ?").get(unitId);
        if (!baseline) return res.status(404).json({ error: "College not found" });
        return res.json(deps.withScorecardMeta({
          name: baseline.name, tuitionInState: baseline.tuition_in, tuitionOutState: baseline.tuition_out,
          medianEarnings10yr: baseline.median_earnings_10yr,
          interpretation: "Limited financial data in offline mode. Configure SCORECARD_API_KEY for full profiles.",
          source: "Baseline data (limited)",
        }, {
          cached: false,
          stale: true,
          fallback: true,
          fallbackReason: "scorecard_not_configured",
          dataFreshness: "baseline",
        }));
      }
      const cached = deps.getScorecardQueryCache("financial_aid", { unitId });
      if (cached?.data) {
        return res.json(deps.withScorecardMeta(cached.data, {
          cached: true,
          cacheKind: "financial_aid",
          dataFreshness: "current",
        }));
      }
      const profile = await getFinancialAidProfile(deps.SCORECARD_API_KEY, unitId);
      if (profile.error) return res.status(404).json(profile);
      deps.putScorecardQueryCache("financial_aid", { unitId }, profile);
      res.json(deps.withScorecardMeta(profile, {
        cached: false,
        cacheKind: "financial_aid",
        dataFreshness: "current",
      }));
    } catch (err) {
      console.error("[SCORECARD] Financial aid error:", err.message);
      res.status(500).json({ error: "Financial aid lookup failed" });
    }
  });

  // ── GET /api/colleges/:id/history — 10-year Scorecard trend data ─────────
  // Returns cached data instantly when available; fetches live on first call.
  // Auth: any authenticated student (not limited to their own goal list so
  // counselors can pull arbitrary schools from the audit dashboard too).
  app.get("/api/colleges/:id/history", deps.scorecardLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const unitId = deps.normalizeUnitId(req.params.id);
      if (!unitId || !/^\d{5,8}$/.test(unitId)) {
        return res.status(400).json({ error: "Valid numeric unit ID required (5-8 digits)" });
      }

      const cachedRows = deps.ragStmts.getScorecardHistory?.all(unitId) || [];
      const hasFreshCache = !!deps.ragStmts.getScorecardCache?.get(unitId);

      if (cachedRows.length > 0 && hasFreshCache) {
        const [entry] = buildCollegeHistoryContext(deps.ragStmts, [unitId]);
        return res.json(deps.withScorecardMeta(entry, {
          cached: true,
          dataFreshness: "current",
        }));
      }

      if (!deps.SCORECARD_API_KEY) {
        if (cachedRows.length > 0) {
          const [entry] = buildCollegeHistoryContext(deps.ragStmts, [unitId]);
          return res.json(deps.withScorecardMeta({
            ...entry,
            warning: "SCORECARD_API_KEY not configured; showing stale cached data",
          }, {
            cached: true,
            stale: true,
            fallback: true,
            fallbackReason: "scorecard_not_configured",
            dataFreshness: "stale",
          }));
        }
        return res.status(503).json({ error: "SCORECARD_API_KEY not configured. Add it to .env to enable historical data." });
      }

      const result = await getCollegeHistory(deps.SCORECARD_API_KEY, unitId, 10);
      if (result.error) {
        if (cachedRows.length > 0) {
          const [entry] = buildCollegeHistoryContext(deps.ragStmts, [unitId]);
          return res.json(deps.withScorecardMeta({
            ...entry,
            warning: result.error,
          }, {
            cached: true,
            stale: true,
            fallback: true,
            fallbackReason: "scorecard_live_error",
            dataFreshness: "stale",
          }));
        }
        return res.status(404).json({ error: result.error });
      }

      try {
        deps.db.transaction(() => {
          deps.ragStmts.upsertScorecardCache.run(unitId, result.name, JSON.stringify(result));
          for (const yr of result.history) {
            deps.ragStmts.upsertScorecardHistory.run(
              unitId, yr.year, result.name,
              yr.admissionRate, yr.sat25, yr.sat75,
              yr.act25, yr.act75,
              yr.tuitionIn, yr.tuitionOut, yr.avgNetPrice,
              yr.enrollment, yr.gradRate, yr.medianEarnings
            );
          }
        })();
      } catch (dbErr) {
        console.warn("[SCORECARD] History DB write error:", dbErr.message);
      }

      const [entry] = buildCollegeHistoryContext(deps.ragStmts, [unitId]);
      res.json(deps.withScorecardMeta(entry || { unitId, available: false }, {
        cached: false,
        dataFreshness: "current",
      }));
    } catch (err) {
      console.error("[SCORECARD] History endpoint error:", err.message);
      res.status(500).json({ error: "College history lookup failed" });
    }
  });

  app.post("/api/colleges/compare", deps.scorecardLimiter, async (req, res) => {
    try {
      const { unitIds } = req.body;
      if (!Array.isArray(unitIds) || unitIds.length < 2) return res.status(400).json({ error: "Provide at least 2 unit IDs" });
      if (unitIds.length > 8) return res.status(400).json({ error: "Maximum 8 colleges" });

      if (!deps.SCORECARD_API_KEY) {
        const colleges = unitIds.map(id => {
          const b = deps.db.prepare("SELECT * FROM baseline_colleges WHERE unit_id = ?").get(id);
          if (!b) return null;
          return {
            unitId: b.unit_id, name: b.name, state: b.state,
            sat25: b.sat_25, sat75: b.sat_75,
            acceptanceRate: b.acceptance_rate != null ? Math.round(b.acceptance_rate * 1000) / 10 : null,
            enrollment: b.enrollment, tuitionIn: b.tuition_in, tuitionOut: b.tuition_out,
            gradRate: b.grad_rate_6yr, retentionRate: b.retention_rate,
            medianEarnings10yr: b.median_earnings_10yr,
          };
        }).filter(Boolean);
        if (colleges.length < 2) return res.status(400).json({ error: "Need at least 2 valid colleges" });

        const dimensions = [
          { key: "acceptanceRate", label: "Acceptance Rate", format: "pct", lowerBetter: true },
          { key: "sat25", label: "SAT 25th", format: "num" },
          { key: "sat75", label: "SAT 75th", format: "num" },
          { key: "tuitionIn", label: "In-State Tuition", format: "usd", lowerBetter: true },
          { key: "tuitionOut", label: "Out-of-State Tuition", format: "usd", lowerBetter: true },
          { key: "enrollment", label: "Enrollment", format: "num" },
          { key: "gradRate", label: "Graduation Rate", format: "pct" },
          { key: "retentionRate", label: "Freshman Retention", format: "pct" },
          { key: "medianEarnings10yr", label: "Median Earnings (10yr)", format: "usd" },
        ];
        const fmtVal = (v, fmt) => { if (v == null) return "N/A"; if (fmt === "pct") return `${Math.round(v * 100)}%`; if (fmt === "usd") return `$${v.toLocaleString()}`; return v.toLocaleString(); };
        const matrix = dimensions.map(dim => {
          const values = colleges.map(c => ({ school: c.name, value: c[dim.key], formatted: fmtVal(c[dim.key], dim.format) }));
          const sorted = [...values].filter(v => v.value != null).sort((a, b) => dim.lowerBetter ? a.value - b.value : b.value - a.value);
          return { dimension: dim.label, values: values.map(v => ({ ...v, rank: sorted.findIndex(s => s.school === v.school) + 1 || null })) };
        });
        return res.json({ colleges: colleges.map(c => ({ unitId: c.unitId, name: c.name, state: c.state })), matrix, source: "Baseline data" });
      }

      const comparePayload = deps.normalizeComparePayload(unitIds);
      const cached = deps.getScorecardQueryCache("compare", comparePayload);
      if (cached?.data) {
        const requestedOrder = unitIds.map((id) => deps.normalizeUnitId(id));
        const orderedColleges = Array.isArray(cached.data.colleges)
          ? [...cached.data.colleges].sort((a, b) =>
            requestedOrder.indexOf(deps.normalizeUnitId(a.unitId)) - requestedOrder.indexOf(deps.normalizeUnitId(b.unitId)))
          : [];
        const orderedNames = orderedColleges.map((c) => c.name);
        const orderedMatrix = Array.isArray(cached.data.matrix)
          ? cached.data.matrix.map((dimension) => ({
            ...dimension,
            values: Array.isArray(dimension.values)
              ? [...dimension.values].sort((a, b) => orderedNames.indexOf(a.school) - orderedNames.indexOf(b.school))
              : [],
          }))
          : [];
        return res.json(deps.withScorecardMeta({
          ...cached.data,
          colleges: orderedColleges,
          matrix: orderedMatrix,
        }, {
          cached: true,
          cacheKind: "compare",
          dataFreshness: "current",
        }));
      }
      const result = await compareColleges(deps.SCORECARD_API_KEY, unitIds);
      if (result.error) return res.status(400).json(result);
      deps.putScorecardQueryCache("compare", comparePayload, result);
      res.json(deps.withScorecardMeta(result, {
        cached: false,
        cacheKind: "compare",
        dataFreshness: "current",
      }));
    } catch (err) {
      console.error("[SCORECARD] Comparison error:", err.message);
      res.status(500).json({ error: "College comparison failed" });
    }
  });
}
