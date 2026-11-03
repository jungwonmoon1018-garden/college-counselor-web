// server/fit-context.js — the school side of a College Fit read, assembled
// in one place for the card (runPositioning) and the priorities matrix under
// it (profileComparisonForSchool).
//
// The two used to build their own: the matrix had no stated test policy and
// no admit rate, so at a school whose Common Data Set reads test-optional
// and whose own pages require scores (Dartmouth), the card flagged a missing
// required score while the matrix beneath it said "consider withholding",
// and the rigor line expected five courses on one and four on the other
// (fit-8). Both now take the record, the pick between it and the baseline
// row, the admit rate and its pools, and the stated policy from here; only
// the live work (the CDS search, the College Scorecard fill) stays with the
// card, where the latency is expected.
//
// `deps` is server.js's routeDeps object (db, ragStmts, policyScoutStmts,
// resolveBaselineCollegeRow, normalizeUnitId).

import { cdsRecordToPositioningResult, cdsVerification, isCdsRecordValidated, resolveStoredCdsRecord } from "../cds/cds-store.js";
import { admitRatePools, statedTestPolicy } from "../colleges/positioning-engine.js";
import { readPolicySnapshot } from "../scouts/admissions-policy-scout.js";
import { safeParseJSON } from "./model-calls.js";

// The stored record for a school: the name the student asked for first,
// then the name the repository or the baseline gave. The repository index
// resolved "Purdue University" to Purdue University Northwest on 2026-09-22
// while the store held the main campus.
export function resolveFitRecord(deps, { requestedName = null, lookupName = null } = {}) {
  return (requestedName ? resolveStoredCdsRecord(deps.ragStmts, { schoolName: requestedName }) : null)
    || (lookupName ? resolveStoredCdsRecord(deps.ragStmts, { schoolName: lookupName }) : null)
    || null;
}

// The college context the engine reads, from the baseline row and the
// stored record. A validated record's enrolled ranges are the freshest
// ground truth and come first; otherwise the baseline row does, and the
// record fills what it lacks. `fieldSources` says where the admit rate and
// each band came from, so a later fill (College Scorecard) can say so too.
export function buildCollegeContext(deps, { collegeRow = null, storedCds = null, cdsResult = null, unitId = null } = {}) {
  const cdsValidated = storedCds ? isCdsRecordValidated(deps.ragStmts, storedCds.slug) : false;
  const cdsVerified = storedCds ? cdsVerification(deps.ragStmts, storedCds.slug) : "unverified";
  const effectiveCds = storedCds
    ? cdsRecordToPositioningResult(storedCds, { liveFallback: cdsResult, unitId, validated: cdsVerified === "validated", verification: cdsVerified })
    : cdsResult;

  // Validated CDS admit rate takes precedence over the IPEDS baseline.
  const cdsAdmitPercent = storedCds?.overallAdmitRate != null
    ? Math.round(storedCds.overallAdmitRate * 1000) / 10
    : null;
  const baselineAdmitPercent = collegeRow?.acceptance_rate != null
    ? Math.round(Number(collegeRow.acceptance_rate) * 1000) / 10
    : null;
  const liveAdmitPercent = effectiveCds?.parsed?.admitRatePercent ?? null;

  const cdsFirst = Boolean(storedCds && cdsValidated);
  const recordSource = "cds_store";
  const baselineSource = collegeRow?.source || "baseline_colleges";
  // The value and where it came from, by the pick rule.
  const pick = (cdsVal, baseVal) => {
    const first = cdsFirst ? [cdsVal, recordSource] : [baseVal, baselineSource];
    const second = cdsFirst ? [baseVal, baselineSource] : [cdsVal, recordSource];
    if (first[0] != null) return first;
    if (second[0] != null) return second;
    return [null, null];
  };
  const fieldSources = {};
  const take = (field, [value, source]) => { if (value != null) fieldSources[field] = source; return value; };

  const sat25 = take("sat_range", pick(storedCds?.enrolledSAT?.p25, collegeRow?.sat_25));
  const sat75 = pick(storedCds?.enrolledSAT?.p75, collegeRow?.sat_75)[0];
  const act25 = take("act_range", pick(storedCds?.enrolledACT?.p25, collegeRow?.act_25));
  const act75 = pick(storedCds?.enrolledACT?.p75, collegeRow?.act_75)[0];
  let acceptanceRate = null;
  if (cdsAdmitPercent != null) { acceptanceRate = cdsAdmitPercent; fieldSources.acceptance_rate = recordSource; }
  else if (baselineAdmitPercent != null) { acceptanceRate = baselineAdmitPercent; fieldSources.acceptance_rate = baselineSource; }
  else if (liveAdmitPercent != null) { acceptanceRate = liveAdmitPercent; fieldSources.acceptance_rate = "cds_live"; }

  const collegeContext = {
    unitId: collegeRow?.unit_id || unitId || null,
    name: collegeRow?.name || storedCds?.school || cdsResult?.schoolName || null,
    state: collegeRow?.state || null,
    sat25: sat25 ?? null,
    sat75: sat75 ?? null,
    act25: act25 ?? null,
    act75: act75 ?? null,
    acceptanceRate,
    // The admit rate outside Early Decision, from the CDS's own counts,
    // as fractions (admitRatePools); the read starts from it.
    admitRatePools: storedCds ? admitRatePools(storedCds) : null,
    avgGpaAdmitted: pick(storedCds?.enrolledGPA?.avg, collegeRow?.avg_gpa_admitted)[0] ?? effectiveCds?.parsed?.gpaAverage ?? null,
    topMajors: safeParseJSON(collegeRow?.top_majors_json, []),
    source: cdsFirst ? "cds_store" : (collegeRow?.source || (storedCds ? "cds_store" : "baseline_colleges")),
    fieldSources,
  };
  return { collegeContext, effectiveCds, cdsValidated, cdsVerified };
}

// The test policy a school states this cycle on its own admissions pages,
// as the policy scout last read them, outranks the Common Data Set's, which
// describes a class that entered a year or two ago (statedTestPolicy). The
// read is a cheap table lookup; without one the CDS policy stands.
export function withStatedPolicy(deps, collegeContext, effectiveCds) {
  let stated = null;
  try {
    stated = statedTestPolicy(readPolicySnapshot(deps.policyScoutStmts, { unitId: collegeContext.unitId, name: collegeContext.name }));
  } catch {
    stated = null;
  }
  const cdsForRead = stated
    ? {
      ...(effectiveCds || {}),
      parsed: { ...(effectiveCds?.parsed || {}), testPolicy: stated.bucket, testPolicyStated: stated },
      testPolicySource: `official admissions site (policy scout, checked ${String(stated.checkedAt).slice(0, 10)})`,
    }
    : effectiveCds;
  return { stated, cdsForRead };
}

// Everything the matrix needs for one school by name, from local data
// only. Null when nothing is held for the school.
export function localFitContext(deps, schoolName, { wanted = schoolName } = {}) {
  const collegeRow = deps.resolveBaselineCollegeRow(deps.db, { schoolName: wanted });
  const storedCds = resolveFitRecord(deps, { requestedName: wanted, lookupName: collegeRow?.name || null });
  if (!storedCds && !collegeRow) return null;
  const built = buildCollegeContext(deps, { collegeRow, storedCds, cdsResult: null, unitId: collegeRow?.unit_id || null });
  if (!built.collegeContext.name) built.collegeContext.name = wanted;
  const { stated, cdsForRead } = withStatedPolicy(deps, built.collegeContext, built.effectiveCds);
  return { collegeRow, storedCds, ...built, stated, cdsForRead };
}
