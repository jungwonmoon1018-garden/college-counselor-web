// server/positioning.js — runPositioning, the College Fit read for one student
// and one school list, with the CDS search-and-persist it leans on. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (CDS_LIVE_COOLDOWN_MS, SCORECARD_API_KEY,
// admissionsIntelStmts, cdsLiveAttemptAt, db, getScorecardQueryCache,
// normalizeUnitId, putScorecardQueryCache, ragStmts,
// resolveBaselineCollegeRow).
import { cdsRecordToPositioningResult, cdsVerification, isCdsRecordValidated, resolveStoredCdsRecord, schoolNamesCompatible, slugifySchoolName } from "../cds-store.js";
import { httpError, safeParseJSON } from "../server/model-calls.js";
import { extractGoalUnitIds } from "../rag-engine.js";
import { computeCdsQueryCacheKey, extractTargetSchoolNames, resolveAndParseCdsTargets } from "../cds-search.js";
import { getActiveNarrative } from "../narrative-store.js";
import { buildPositioningForTarget, buildStudentModel } from "../positioning-engine.js";
import { resolveIpedsGrowthForMajor, resolveMajorPolicyForSchool, resolveStrategicFocusForSchool } from "../admissions-intelligence.js";
import { expandCollegeAlias, pickScorecardHit } from "../college-research.js";
import { getCollegeById, searchScorecard } from "../college-scorecard.js";
import { rememberFitRead } from "../server/verified-data.js";

let deps;
export function bindPositioning(serverDeps) { deps = serverDeps; }

export async function searchAndPersistCdsRecord(schoolName) {
  if (!schoolName) return null;
  const slug = slugifySchoolName(schoolName);
  if (!slug) return null;
  const last = deps.cdsLiveAttemptAt.get(slug) || 0;
  if (Date.now() - last < deps.CDS_LIVE_COOLDOWN_MS) return null; // recently tried; don't hammer
  deps.cdsLiveAttemptAt.set(slug, Date.now());
  try {
    const { ingestOne } = await import("./cds-ingest-pipeline.js");
    const r = await ingestOne(deps.ragStmts, schoolName);
    const persisted = r && ["ok", "discrepancies", "scope_mismatch", "no_truth"].includes(r.status);
    if (persisted) {
      // Guard against the repository's fuzzy index binding the wrong school
      // (e.g. "Boston University" → "Boston College"). If the matched name is
      // not the same institution, discard and fall back to IPEDS baseline.
      if (!schoolNamesCompatible(schoolName, r.school)) {
        console.warn(`[cds/live-search] repository returned "${r.school}" for "${schoolName}" — rejecting mismatch`);
        return null;
      }
      console.log(`[cds/live-search] ingested ${schoolName} → ${r.slug} (${r.status})`);
      return resolveStoredCdsRecord(deps.ragStmts, { schoolName, slug: r.slug });
    }
    console.log(`[cds/live-search] no CDS for ${schoolName} (${r?.status || "unknown"})`);
  } catch (e) {
    console.warn(`[cds/live-search] failed for ${schoolName}:`, String(e.message).slice(0, 160));
  }
  return null;
}

// A cheap fingerprint of the CDS store (row count + latest update). Folded into
// the positioning/CDS cache keys so a CDS refresh invalidates stale fit results.
export function currentCdsVersion() {
  try {
    const r = deps.db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM cds_records").get();
    return `${r?.n || 0}:${r?.m || "0"}`;
  } catch {
    return "0";
  }
}

// The College Fit computation, shared by the targets route and the
// double-check. Returns the response payload plus, unless served from the
// positioning cache, the per-target inputs the scores were computed from.
export async function runPositioning({ studentId, body = {}, bypassCache = false } = {}) {
    const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
    if (!snap) throw httpError(404, "No profile data");

    const goals = safeParseJSON(snap.goals_json, []);
    const goalUnitIds = extractGoalUnitIds(goals);
    const fallbackRows = goalUnitIds
      .map((unitId) => deps.db.prepare("SELECT unit_id, name, state, sat_25, sat_75, act_25, act_75, acceptance_rate, avg_gpa_admitted, top_majors_json, source FROM baseline_colleges WHERE unit_id = ?").get(unitId))
      .filter(Boolean);

    const requestedTargets = Array.isArray(body?.targets) ? body.targets : null;
    const rawTargets = requestedTargets || extractTargetSchoolNames(goals, fallbackRows);
    if (!rawTargets.length) throw httpError(400, "No target universities found");

    const requestedMajor = body?.major || snap.major_interest || null;
    const refreshCds = Boolean(body?.refreshCds);
    const cacheKey = computeCdsQueryCacheKey(rawTargets);
    // Fold a CDS data version into every cache key so a CDS refresh (which
    // bumps cds_records.updated_at) invalidates stale cached fit results — the
    // reason a freshly-scraped CDS wasn't reaching the College Fit tab.
    const cdsVersion = currentCdsVersion();
    let cdsResults = null;
    if (!refreshCds) {
      const cachedCds = deps.getScorecardQueryCache("cds_targets", { cacheKey, cdsVersion, targets: rawTargets });
      cdsResults = cachedCds?.data?.results || null;
      // The read is this student's: keyed by student and by the snapshot
      // it was computed from, so one student's fit (which now carries their
      // own scores, rank and GPA against the school) is never served to
      // another with the same targets, and a profile edit recomputes it.
      const cachedPositioning = bypassCache ? null : deps.getScorecardQueryCache("positioning_targets", { cacheKey, cdsVersion, targets: rawTargets, major: requestedMajor, studentId, snapshot: snap.id });
      if (cachedPositioning?.data) {
        return { payload: cachedPositioning.data, cached: true, internals: null };
      }
    }

    if (!cdsResults) {
      cdsResults = (await resolveAndParseCdsTargets(rawTargets));
      deps.putScorecardQueryCache("cds_targets", { cacheKey, cdsVersion, targets: rawTargets }, {
        targets: rawTargets,
        results: cdsResults,
        source: "College Transitions CDS repository",
      });
    }

    const strengthRows = deps.ragStmts.strength.getByStudent.all(studentId);
    const narrative = getActiveNarrative(deps.ragStmts.narrative, studentId);
    const studentModel = buildStudentModel({
      gpa_unweighted: snap.gpa_unweighted,
      gpa_weighted: snap.gpa_weighted,
      courses_json: snap.courses_json,
      test_scores_json: snap.test_scores_json,
      ap_scores_json: snap.ap_scores_json,
      class_rank_json: snap.class_rank_json,
      activities_json: snap.activities_json,
      major_interest: requestedMajor,
    }, strengthRows, narrative);

    const majorPolicies = body?.majorPolicies || {};
    const ipedsGrowthByBucket = body?.ipedsGrowthByBucket || {};
    // Live CDS search: when a searched school isn't already in the store,
    // fetch + parse + persist its CDS (Drive-hosted PDFs are supported; the
    // ~10% Google-Sheets/Docs sources are skipped and fall back to IPEDS
    // baseline). On by default; live-parsed records are tagged unvalidated
    // (lower confidence) so a mis-parse can't masquerade as ground truth.
    const searchCds = body?.searchCds !== false;

    // Web fallback: when neither the store nor the live PDF pipeline yields a
    // CDS, use the student's highest web-capable model to search + read the
    // school's CDS. On by default; budget-gated, BYOK-required, capped per
    // request, and cooldown-deduped so it can't run away on cost. Results are
    // tagged unvalidated (web-read) with lower confidence.
    const internals = [];
    const scoredTargets = await Promise.all(cdsResults.map(async (cdsResult) => {
      const requested = rawTargets.find((target) =>
        (cdsResult.unitId && deps.normalizeUnitId(target.unitId) === deps.normalizeUnitId(cdsResult.unitId)) ||
        String(target.schoolName || "").toLowerCase() === String(cdsResult.schoolName || "").toLowerCase()
      ) || null;

      const resolvedUnitId = deps.normalizeUnitId(cdsResult.unitId || requested?.unitId);
      const collegeRow = deps.resolveBaselineCollegeRow(deps.db, {
        unitId: resolvedUnitId,
        schoolName: cdsResult.schoolName || requested?.schoolName,
      });

      // ── Prefer the on-disk validated CDS record over the live fetch ──
      // The stored record carries real C7 weights, a validated admit rate,
      // and enrolled test-score ranges, so the calculation grounds in real
      // data (and evidence confidence stops reading "Very Low") whenever we
      // have a CDS record for this school.
      const lookupName = cdsResult.schoolName || requested?.schoolName || collegeRow?.name;
      let storedCds = resolveStoredCdsRecord(deps.ragStmts, { schoolName: lookupName });
      // Not in the store yet? Search this university's CDS live, parse, and
      // persist it — so searching a school in College Fit also pulls its CDS.
      if (!storedCds && searchCds) {
        storedCds = await searchAndPersistCdsRecord(lookupName);
      }
      const cdsValidated = storedCds ? isCdsRecordValidated(deps.ragStmts, storedCds.slug) : false;
      const cdsVerified = storedCds ? cdsVerification(deps.ragStmts, storedCds.slug) : "unverified";
      const effectiveCds = storedCds
        ? cdsRecordToPositioningResult(storedCds, { liveFallback: cdsResult, unitId: resolvedUnitId, validated: cdsVerified === "validated", verification: cdsVerified })
        : cdsResult;

      // Validated CDS admit rate takes precedence over the IPEDS baseline.
      const cdsAdmitPercent = storedCds?.overallAdmitRate != null
        ? Math.round(storedCds.overallAdmitRate * 1000) / 10
        : null;
      const baselineAdmitPercent = collegeRow?.acceptance_rate != null
        ? Math.round(Number(collegeRow.acceptance_rate) * 1000) / 10
        : null;

      // When we have a VALIDATED CDS record, its enrolled ranges are the
      // freshest ground truth — prefer them over the static IPEDS baseline so
      // the academic-readiness scoring reflects the newest CDS (the baseline
      // row, used first before, made fit ignore a just-scraped CDS). Fall back
      // to baseline only for fields the CDS lacks.
      const cdsFirst = storedCds && cdsValidated;
      const pick = (cdsVal, baseVal) => (cdsFirst ? (cdsVal ?? baseVal) : (baseVal ?? cdsVal));
      const collegeContext = {
        unitId: collegeRow?.unit_id || resolvedUnitId || null,
        name: collegeRow?.name || storedCds?.school || cdsResult.schoolName,
        state: collegeRow?.state || null,
        sat25: pick(storedCds?.enrolledSAT?.p25, collegeRow?.sat_25) ?? null,
        sat75: pick(storedCds?.enrolledSAT?.p75, collegeRow?.sat_75) ?? null,
        act25: pick(storedCds?.enrolledACT?.p25, collegeRow?.act_25) ?? null,
        act75: pick(storedCds?.enrolledACT?.p75, collegeRow?.act_75) ?? null,
        acceptanceRate: cdsAdmitPercent ?? baselineAdmitPercent ?? effectiveCds?.parsed?.admitRatePercent ?? null,
        avgGpaAdmitted: pick(storedCds?.enrolledGPA?.avg, collegeRow?.avg_gpa_admitted) ?? effectiveCds?.parsed?.gpaAverage ?? null,
        topMajors: safeParseJSON(collegeRow?.top_majors_json, []),
        source: cdsFirst ? "cds_store" : (collegeRow?.source || (storedCds ? "cds_store" : "baseline_colleges")),
      };

      // ── College Scorecard fallback ──────────────────────────────────
      // The CDS store covers a few dozen schools and, on a fresh deployment,
      // baseline_colleges holds only the manually curated set — so most
      // searched schools reached this point with NO stats at all and the fit
      // calibration had nothing to work with. The live Scorecard API (the
      // Dept. of Education's IPEDS data) fills admit rate and test ranges for
      // any US school, connecting the CDS pipeline to Scorecard data.
      if (deps.SCORECARD_API_KEY &&
          collegeContext.sat25 == null && collegeContext.act25 == null && collegeContext.acceptanceRate == null) {
        try {
          const scorecardName = expandCollegeAlias(collegeContext.name);
          const scorecardHit = collegeContext.unitId
            ? await getCollegeById(deps.SCORECARD_API_KEY, collegeContext.unitId)
            : pickScorecardHit(
              (await searchScorecard(deps.SCORECARD_API_KEY, { name: scorecardName, limit: 20 }))?.results,
              scorecardName,
            );
          if (scorecardHit) {
            collegeContext.unitId = collegeContext.unitId || scorecardHit.unitId || null;
            collegeContext.name = collegeContext.name || scorecardHit.name;
            collegeContext.state = collegeContext.state || scorecardHit.state || null;
            collegeContext.sat25 = scorecardHit.sat25 ?? null;
            collegeContext.sat75 = scorecardHit.sat75 ?? null;
            collegeContext.act25 = scorecardHit.act25 ?? null;
            collegeContext.act75 = scorecardHit.act75 ?? null;
            collegeContext.acceptanceRate = scorecardHit.acceptanceRate ?? null;
            collegeContext.source = "college_scorecard";
          }
        } catch (err) {
          console.warn("[POSITIONING] Scorecard fallback failed:", err?.message);
        }
      }

      const majorPolicy =
        resolveMajorPolicyForSchool(deps.admissionsIntelStmts, {
          unitId: collegeContext.unitId,
          schoolName: collegeContext.name,
          major: requestedMajor,
        }) ||
        majorPolicies?.[collegeContext.unitId] ||
        majorPolicies?.[collegeContext.name] ||
        null;
      const ipedsGrowthSignal = resolveIpedsGrowthForMajor(deps.admissionsIntelStmts, {
        unitId: collegeContext.unitId,
        major: requestedMajor,
      });
      const strategicSignals = resolveStrategicFocusForSchool(deps.admissionsIntelStmts, {
        unitId: collegeContext.unitId,
        major: requestedMajor,
        limit: 5,
      });
      const positioningOptions = {
        major: requestedMajor,
        majorPolicy,
        ipedsGrowthByBucket: {
          ...(ipedsGrowthByBucket || {}),
          [studentModel.majorBucket]: ipedsGrowthSignal?.growthRate ?? ipedsGrowthByBucket?.[studentModel.majorBucket] ?? null,
        },
        strategicSignals,
      };
      const positioning = buildPositioningForTarget(studentModel, collegeContext, effectiveCds, positioningOptions);
      internals.push({
        schoolName: positioning.schoolName,
        collegeContext: { ...collegeContext },
        effectiveCds,
        options: positioningOptions,
        website: collegeRow?.website || null,
        cdsYear: storedCds?.year ?? null,
        cdsValidated,
      });
      // Surface where the numbers came from so the card can link to the CDS
      // source and show the reporting year.
      positioning.dataProvenance = effectiveCds?.provenance || {
        kind: storedCds
          ? "cds_store"
          : (cdsResult?.fetchStatus === "ok"
            ? "cds_live"
            : (collegeContext.source === "college_scorecard" ? "college_scorecard" : "baseline_only")),
        validated: Boolean(storedCds),
        sourceUrl: effectiveCds?.sourceUrl
          || (collegeContext.source === "college_scorecard" ? "https://collegescorecard.ed.gov/" : null),
      };
      return positioning;
    }));

    const payload = {
      major: requestedMajor,
      modelVersion: "positioning_mvp_v1",
      separation: {
        admissibility: "academic preparation for the target school-major pair",
        competitiveness: "crowding and selectivity pressure in the target applicant pool",
        fit: "alignment with institutional and departmental priorities",
        confidence: "strength and directness of the supporting evidence",
      },
      source: "College Transitions CDS repository + NCES/IPEDS baseline + unified EC strength",
      targets: scoredTargets,
    };

    deps.putScorecardQueryCache("positioning_targets", { cacheKey, cdsVersion, targets: rawTargets, major: requestedMajor, studentId, snapshot: snap.id }, payload);
    for (const target of scoredTargets) rememberFitRead(studentId, target);
    return { payload, cached: false, internals };
}
