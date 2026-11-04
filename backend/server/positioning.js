// server/positioning.js — runPositioning, the College Fit read for one student
// and one school list, with the CDS search-and-persist it leans on. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (CDS_LIVE_COOLDOWN_MS, SCORECARD_API_KEY,
// admissionsIntelStmts, cdsLiveAttemptAt, db, getScorecardQueryCache,
// normalizeUnitId, policyScoutStmts, putScorecardQueryCache, ragStmts,
// resolveBaselineCollegeRow).
import { resolveStoredCdsRecord, schoolNamesCompatible, slugifySchoolName } from "../cds/cds-store.js";
import { httpError, safeParseJSON } from "./model-calls.js";
import { extractGoalUnitIds } from "../storage/rag-engine.js";
import { computeCdsQueryCacheKey, extractTargetSchoolNames, resolveAndParseCdsTargets } from "../cds/cds-search.js";
import { cycleStartYear } from "../cds/cds-cycle.js";
import { getActiveNarrative } from "../activities/narrative-store.js";
import { POSITIONING_MODEL_VERSION, buildPositioningForTarget, buildStudentModel } from "../colleges/positioning-engine.js";
import { SCOUT_VERSION } from "../scouts/admissions-policy-scout.js";
import { resolveIpedsGrowthForMajor, resolveMajorPolicyForSchool, resolveStrategicFocusForSchool } from "../colleges/admissions-intelligence.js";
import { expandCollegeAlias, pickScorecardHit } from "../colleges/college-research.js";
import { getCollegeByIdResult, searchScorecard } from "../colleges/college-scorecard.js";
import { rememberFitRead } from "./verified-data.js";
import { buildCollegeContext, resolveFitRecord, withStatedPolicy } from "./fit-context.js";

let deps;
export function bindPositioning(serverDeps) { deps = serverDeps; }

// The ingest statuses that leave a usable row in the store. "consistent" —
// the school's own document reading sanely, with no same-cycle truth to
// check it against — joined the validator on 2026-09-16 but not this list,
// so a successful live read was logged as "no CDS" and only served the next
// request. "inconsistent" records are not used, "unchanged" and
// "kept_newer" mean the store already held the record before this read.
const LIVE_INGEST_STORED = new Set(["ok", "discrepancies", "scope_mismatch", "no_truth", "consistent", "unchanged", "kept_newer"]);
export function liveIngestStored(status) { return LIVE_INGEST_STORED.has(status); }

// How long a College Fit request waits for a live read. A text document is
// downloaded and parsed in a few seconds; a scanned one is rasterized and
// recognized page by page, one page at a time for the whole process (the OCR
// lane in shared/file-extractors.js), which takes minutes and used to hold
// the request past the browser's 45-second limit. Past this wait the answer
// uses the baseline, the read finishes in the background, and the stored
// record serves the next request.
const CDS_LIVE_WAIT_MS = 20_000;

export async function searchAndPersistCdsRecord(schoolName) {
  if (!schoolName) return null;
  const slug = slugifySchoolName(schoolName);
  if (!slug) return null;
  const last = deps.cdsLiveAttemptAt.get(slug) || 0;
  if (Date.now() - last < deps.CDS_LIVE_COOLDOWN_MS) return null; // recently tried; don't hammer
  deps.cdsLiveAttemptAt.set(slug, Date.now());
  const read = (async () => {
    try {
      const { ingestOne } = await import("../cds/cds-ingest-pipeline.js");
      const r = await ingestOne(deps.ragStmts, schoolName);
      const persisted = liveIngestStored(r?.status);
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
  })();
  return valueWithin(read, CDS_LIVE_WAIT_MS);
}

// The promise's value, or null once `ms` has passed; the work is not
// cancelled, only no longer waited for.
export function valueWithin(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms).unref()),
  ]);
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

// The same for the policy scout's readings: a new school read, or a policy
// that changed, and the scout's own version. A corrected test policy used
// to keep its wrong red flag (or its missing one) on a cached read for up
// to a week (debt-5).
export function currentPolicyVersion() {
  try {
    const r = deps.db.prepare("SELECT COUNT(*) AS n, MAX(changed_at) AS c FROM admissions_policy_snapshots").get();
    return `${SCOUT_VERSION}:${r?.n || 0}:${r?.c || "0"}`;
  } catch {
    return `${SCOUT_VERSION}:0`;
  }
}

// The student's side beyond the profile snapshot: the active narrative and
// the EC strength rows, which change without a new snapshot (saving a
// narrative creates none, and the prestige recompute rewrites the rows).
function studentInputsVersion(narrative, strengthRows) {
  const rows = Array.isArray(strengthRows) ? strengthRows : [];
  const latest = rows.reduce((max, row) => {
    const at = String(row?.updated_at || row?.computed_at || "");
    return at > max ? at : max;
  }, "");
  return `${narrative?.id || "none"}:${narrative?.hash || ""}|${rows.length}:${latest}`;
}

// Every input the positioning payload reads, in one key: the target list
// and requested major, the student and their profile snapshot, their
// narrative and strength rows, the CDS store, the policy scout, and the
// engine version. A source added to the read has to be added here, or a
// change to it is served stale for the cache's seven days.
export function positioningCacheKey({ cacheKey, cdsVersion, targets, major, studentId, snapshot, studentInputs, policyVersion }) {
  return { cacheKey, cdsVersion, targets, major, studentId, snapshot, studentInputs, policy: policyVersion, model: POSITIONING_MODEL_VERSION };
}

// The College Scorecard fills what the stored data lacks, field by field:
// the admit rate, the SAT band, the ACT band, each recorded in
// `fieldSources`. The fallback used to run only when all three were
// missing, so a Common Data Set with SAT bands and no C1 never got an admit
// rate and the read started from an assumed 50% (Occidental; fit-5).
// Returns whether the Scorecard failed, so the caller does not cache a read
// built on that failure.
async function fillFromScorecard(collegeContext) {
  const missing = {
    acceptance_rate: collegeContext.acceptanceRate == null,
    sat_range: collegeContext.sat25 == null,
    act_range: collegeContext.act25 == null,
  };
  if (!deps.SCORECARD_API_KEY || !Object.values(missing).some(Boolean)) return { attempted: false, failed: false };
  const hadNothing = Object.values(missing).every(Boolean);
  try {
    let hit = null;
    let error = null;
    if (collegeContext.unitId) {
      ({ result: hit, error = null } = await getCollegeByIdResult(deps.SCORECARD_API_KEY, collegeContext.unitId));
    } else {
      const scorecardName = expandCollegeAlias(collegeContext.name);
      const search = await searchScorecard(deps.SCORECARD_API_KEY, { name: scorecardName, limit: 20 });
      error = search?.error || null;
      hit = pickScorecardHit(search?.results, scorecardName);
    }
    if (!hit) return { attempted: true, failed: Boolean(error) };
    collegeContext.unitId = collegeContext.unitId || hit.unitId || null;
    collegeContext.name = collegeContext.name || hit.name;
    collegeContext.state = collegeContext.state || hit.state || null;
    collegeContext.fieldSources = collegeContext.fieldSources || {};
    if (missing.acceptance_rate && hit.acceptanceRate != null) {
      collegeContext.acceptanceRate = hit.acceptanceRate;
      collegeContext.fieldSources.acceptance_rate = "college_scorecard";
    }
    if (missing.sat_range && hit.sat25 != null) {
      collegeContext.sat25 = hit.sat25;
      collegeContext.sat75 = hit.sat75 ?? null;
      collegeContext.fieldSources.sat_range = "college_scorecard";
    }
    if (missing.act_range && hit.act25 != null) {
      collegeContext.act25 = hit.act25;
      collegeContext.act75 = hit.act75 ?? null;
      collegeContext.fieldSources.act_range = "college_scorecard";
    }
    // A school known only through the Scorecard reads as a Scorecard read.
    if (hadNothing) collegeContext.source = "college_scorecard";
    return { attempted: true, failed: false };
  } catch (err) {
    console.warn("[POSITIONING] Scorecard fallback failed:", err?.message);
    return { attempted: true, failed: true };
  }
}

// The intended major's policy, growth signal and strategic signals for one
// school. With no recognized major there is nothing major-specific to look
// up: the lookups used to resolve a blank major to computer science and
// read its capped-major policy and growth (fit-1). School-wide strategic
// signals (no subject) still apply.
function majorSignalsFor(collegeContext, { requestedMajor, majorBucket, majorPolicies, ipedsGrowthByBucket }) {
  if (!majorBucket) {
    let strategicSignals = [];
    try {
      if (collegeContext.unitId) {
        strategicSignals = deps.admissionsIntelStmts.getStrategicSignalsByUnitAndSubject.all(collegeContext.unitId, null, 5).map((row) => ({
          signalType: row.signal_type,
          signalTitle: row.signal_title,
          signalSummary: row.signal_summary,
          evidenceStrength: Number(row.evidence_strength || 0),
          recencyScore: Number(row.recency_score || 0),
          sourceUrl: row.source_url,
          sourceTitle: row.source_title,
          publishedAt: row.published_at,
        }));
      }
    } catch { strategicSignals = []; }
    return { major: requestedMajor, majorPolicy: null, ipedsGrowthByBucket: {}, strategicSignals };
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
  return {
    major: requestedMajor,
    majorPolicy,
    ipedsGrowthByBucket: {
      ...(ipedsGrowthByBucket || {}),
      [majorBucket]: ipedsGrowthSignal?.growthRate ?? ipedsGrowthByBucket?.[majorBucket] ?? null,
    },
    strategicSignals,
  };
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
    const strengthRows = deps.ragStmts.strength.getByStudent.all(studentId);
    const narrative = getActiveNarrative(deps.ragStmts.narrative, studentId);
    // The read is this student's: keyed by student and by the snapshot
    // it was computed from, so one student's fit (which now carries their
    // own scores, rank and GPA against the school) is never served to
    // another with the same targets, and a profile edit recomputes it.
    // The model version is part of the key: a changed read is recomputed
    // instead of served from a cache kept seven days.
    const positioningKey = positioningCacheKey({
      cacheKey, cdsVersion, targets: rawTargets, major: requestedMajor, studentId, snapshot: snap.id,
      studentInputs: studentInputsVersion(narrative, strengthRows), policyVersion: currentPolicyVersion(),
    });
    let cdsResults = null;
    if (!refreshCds) {
      const cachedCds = deps.getScorecardQueryCache("cds_targets", { cacheKey, cdsVersion, targets: rawTargets });
      cdsResults = cachedCds?.data?.results || null;
      const cachedPositioning = bypassCache ? null : deps.getScorecardQueryCache("positioning_targets", positioningKey);
      if (cachedPositioning?.data) {
        return { payload: cachedPositioning.data, cached: true, internals: null };
      }
    }

    // Whether any source failed transiently while this read was built (the
    // repository index, a document, the College Scorecard). Such a read is
    // answered but not cached: a degraded read used to be kept seven days
    // like a real one (fit-3, fit-9).
    let degraded = false;
    if (!cdsResults) {
      cdsResults = await resolveAndParseCdsTargets(rawTargets, {
        // A school the store already holds is not downloaded and parsed
        // again on every cache miss; the stored record is what the read uses.
        hasStoredRecord: (target) => Boolean(resolveFitRecord(deps, { requestedName: target?.schoolName || target?.name || null })),
      });
      const transient = cdsResults.some((r) => r?.transientFailure);
      if (transient) degraded = true;
      else {
        deps.putScorecardQueryCache("cds_targets", { cacheKey, cdsVersion, targets: rawTargets }, {
          targets: rawTargets,
          results: cdsResults,
          source: "College Transitions CDS repository",
        });
      }
    }

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
      let storedCds = resolveFitRecord(deps, { requestedName: requested?.schoolName || null, lookupName });
      // Not in the store yet? Search this university's CDS live, parse, and
      // persist it — so searching a school in College Fit also pulls its CDS.
      if (!storedCds && searchCds) {
        storedCds = await searchAndPersistCdsRecord(lookupName);
      }
      const { collegeContext, effectiveCds, cdsValidated } = buildCollegeContext(deps, { collegeRow, storedCds, cdsResult, unitId: resolvedUnitId });
      if (!collegeContext.name) collegeContext.name = lookupName || null;

      // ── College Scorecard fill ──────────────────────────────────────
      // The CDS store covers a few hundred schools and, on a fresh
      // deployment, baseline_colleges holds only the manually curated set,
      // so a searched school can reach this point with no stats at all. The
      // live Scorecard API (the Dept. of Education's IPEDS data) fills the
      // admit rate and test ranges the stored data lacks.
      const scorecardFill = await fillFromScorecard(collegeContext);
      if (scorecardFill.failed) degraded = true;

      const { stated, cdsForRead } = withStatedPolicy(deps, collegeContext, effectiveCds);

      const positioningOptions = majorSignalsFor(collegeContext, {
        requestedMajor,
        majorBucket: studentModel.majorBucket,
        majorPolicies,
        ipedsGrowthByBucket,
      });
      const positioning = buildPositioningForTarget(studentModel, collegeContext, cdsForRead, positioningOptions);
      internals.push({
        schoolName: positioning.schoolName,
        collegeContext: { ...collegeContext },
        effectiveCds: cdsForRead,
        options: positioningOptions,
        website: collegeRow?.website || null,
        // The cycle the record describes, from its label ("2025-26"); the
        // record's `year` is missing or off by one in a third of the store.
        cdsYear: storedCds ? (cycleStartYear(storedCds.yearLabel) ?? storedCds.year ?? null) : null,
        cdsValidated,
      });
      // Surface where the numbers came from so the card can link to the CDS
      // source and show the reporting year. With no record, no baseline row
      // and no Scorecard hit, nothing was held: "none". It used to fall
      // through to "baseline_only", which the card and the chat printed as
      // "IPEDS baseline", a source the read never had.
      const heldNothing = !storedCds && !collegeRow && collegeContext.source !== "college_scorecard"
        && collegeContext.acceptanceRate == null && collegeContext.sat25 == null && collegeContext.act25 == null;
      positioning.dataProvenance = {
        ...(effectiveCds?.provenance || {
          kind: storedCds
            ? "cds_store"
            : (cdsResult?.fetchStatus === "ok"
              ? "cds_live"
              : (collegeContext.source === "college_scorecard" ? "college_scorecard" : (heldNothing ? "none" : "baseline_only"))),
          validated: Boolean(storedCds),
          sourceUrl: effectiveCds?.sourceUrl
            || (collegeContext.source === "college_scorecard" ? "https://collegescorecard.ed.gov/" : null),
        }),
        // Where the admit rate and each band came from, the College
        // Scorecard among them when it filled a gap.
        fieldSources: { ...(collegeContext.fieldSources || {}) },
        // Which admit rate the read started from; the chat's fit line says so.
        admitRate: positioning.admitRate,
        // Where the test policy came from: the school's own pages this
        // cycle, or the Common Data Set, or nowhere ("unknown").
        testPolicy: stated
          ? { bucket: stated.bucket, value: stated.value, source: "official_site", checkedAt: stated.checkedAt, sourceUrl: stated.sourceUrl }
          : (effectiveCds?.parsed?.testPolicy
            ? { bucket: effectiveCds.parsed.testPolicy, value: effectiveCds.parsed.testPolicyValue ?? null, source: "cds", basis: effectiveCds.parsed.testPolicyBasis ?? null }
            : { bucket: null, source: "unknown" }),
        // The read's own label key and what it lacks, so a stored read
        // tells the chat when no label was given (rememberFitRead).
        labelKey: positioning.labelKey,
        ...(positioning.studentDataNeeded?.length ? { studentDataNeeded: positioning.studentDataNeeded } : {}),
      };
      return positioning;
    }));

    const payload = {
      major: requestedMajor,
      modelVersion: POSITIONING_MODEL_VERSION,
      separation: {
        admissibility: "academic preparation for the target school-major pair",
        competitiveness: "crowding and selectivity pressure in the target applicant pool",
        fit: "alignment with institutional and departmental priorities",
        confidence: "strength and directness of the supporting evidence",
      },
      source: "College Transitions CDS repository + NCES/IPEDS baseline + unified EC strength",
      targets: scoredTargets,
      // True when a source failed while this read was built; it is not
      // cached, so the next request reads again.
      degraded,
    };

    if (!degraded) deps.putScorecardQueryCache("positioning_targets", positioningKey, payload);
    for (const target of scoredTargets) rememberFitRead(studentId, target, { snapshotId: snap.id });
    return { payload, cached: false, internals };
}
