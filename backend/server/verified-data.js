// server/verified-data.js — the VERIFIED DATA block and the official-source
// gate around it: the on-demand reads of a school's own pages and the College
// Scorecard, the profile comparison, the College Fit reads, and the deadlines
// held in the research cache. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (SCORECARD_API_KEY, collegeResearchStmts, db,
// evidenceStmts, factStmts, fitReadStmts, onDemandScouts, policyScoutStmts,
// ragStmts, resolveBaselineCollegeRow, resolveTargetSchools).
import { expandCollegeAlias, pickScorecardHit, readCachedDeadlines, slugifyCollege } from "../college-research.js";
import { safeParseJSON } from "../server/model-calls.js";
import { TOPIC_TYPES, enforceGates } from "../policy-router.js";
import { buildSystemPrompt } from "../orchestration-engine.js";
import { searchFacts } from "../fact-store.js";
import { getEvidenceProfile } from "../evidence-graph.js";
import { formatPolicyLine, readPolicySnapshot, scoutSchool, snapshotAsDeadlineRecord, snapshotIsCurrent } from "../admissions-policy-scout.js";
import { searchScorecard } from "../college-scorecard.js";
import { cdsRecordToPositioningResult, cdsVerification, isCdsRecordValidated, resolveStoredCdsRecord, schoolNamesCompatible } from "../cds-store.js";
import { buildProfileComparison, buildStudentModel, compareApExams, compareCourseRigor, compareGpaToSchool, compareRankToSchool, compareTestsToSchool } from "../positioning-engine.js";
import { getActiveNarrative } from "../narrative-store.js";
import { detectSchoolMentions, formatVerifiedDataBlock } from "../chat-grounding.js";
import { calculateDeadlineStatus, runFAFSAEligibilityCheck } from "../rules-engine.js";

let deps;
export function bindVerifiedData(serverDeps) { deps = serverDeps; }

export function rememberFitRead(studentId, target, { verification = null } = {}) {
  try {
    const slug = slugifyCollege(target?.schoolName || "");
    if (!slug) return;
    deps.fitReadStmts.upsert.run(
      studentId, slug, target.schoolName, target.overallPositioningLabel || null, target.finalPositioningScore ?? null,
      target.admissibility?.academicReadinessScore ?? null, target.competitiveness?.majorCompetitivenessScore ?? null,
      target.fit?.institutionalPriorityFitScore ?? null, target.confidence?.evidenceConfidence || null,
      JSON.stringify(target.dataProvenance || null), verification ? JSON.stringify(verification) : null,
      new Date().toISOString(),
    );
  } catch (err) { console.warn("[fit-read] not saved:", err?.message); }
}

export function fitReadsForStudent(studentId) {
  try {
    return deps.fitReadStmts.byStudent.all(studentId).map((row) => ({
      school: row.school, slug: row.slug, label: row.label, score: row.score,
      admissibility: row.admissibility, competitiveness: row.competitiveness, fit: row.fit,
      confidence: row.confidence, provenance: safeParseJSON(row.provenance_json, null),
      verification: safeParseJSON(row.verification_json, null), computedAt: row.computed_at,
    }));
  } catch { return []; }
}

// The only question the gate still refuses is a pure lookup — an exact
// date or admissions figure — about a named school we hold nothing for,
// after an on-demand read of the official source has been tried. The reply
// says what is missing, gives the typical window as general guidance, and
// points at the official page; it never quotes an unsourced figure.
export function noSourceLookupMessage({ subIntent, school, locale, onDemand }) {
  const dates = String(subIntent || "").includes("deadline");
  const tried = onDemand === "failed" || onDemand === "timeout" || onDemand === "error";
  if (locale === "ko") {
    const s = school || "그 학교";
    const head = dates
      ? `${s}의 확인된 지원 마감일 자료가 아직 없어서 날짜를 추측해 드리지 않겠습니다. 미국 대학의 조기 전형(ED/EA) 마감은 대체로 11월 1일~15일, 정시(RD)는 1월 1일~15일 사이입니다. 정확한 날짜는 ${s}의 공식 입학처 페이지에서 확인하세요.`
      : `${s}의 확인된 입학 통계 자료가 아직 없어서 합격률이나 점수 범위를 추측해 드리지 않겠습니다. 공식 수치는 College Scorecard(collegescorecard.ed.gov)와 ${s}의 Common Data Set에서 확인할 수 있습니다.`;
    return head + (tried ? " 방금 공식 페이지를 직접 읽어 보려 했지만 가져오지 못했습니다. 잠시 후 다시 물어보거나 사이트에서 직접 확인해 주세요." : "");
  }
  const s = school || "that school";
  const head = dates
    ? `I don't have verified application dates for ${s} yet, so I won't guess a deadline. Most Early Decision and Early Action deadlines fall between November 1 and November 15, and Regular Decision between January 1 and January 15; confirm ${s}'s exact dates on its official admissions page.`
    : `I don't have verified admissions statistics for ${s} yet, so I won't quote an acceptance rate or score range I can't source. The College Scorecard (collegescorecard.ed.gov) and ${s}'s Common Data Set publish the official figures.`;
  return head + (tried ? ` I just tried to read ${s}'s official pages and couldn't reach them — ask again in a moment, or check the site directly.` : "");
}

export function regulatedChatGate(classification, studentId, userText, locale, { schoolNamed, schoolName = null, onDemand = null } = {}) {
  const tt = classification?.topicType;
  if (tt !== TOPIC_TYPES.REGULATED && tt !== TOPIC_TYPES.HIGH_STAKES) return {};
  let evidence = [];
  try {
    const facts = searchFacts(deps.factStmts, userText || "", 10) || [];
    const ev = studentId ? getEvidenceProfile(deps.evidenceStmts, "student", studentId) : null;
    evidence = [...facts, ...((ev && ev.items) || [])];
  } catch { /* no evidence → the gate decides on the question alone */ }
  const gate = enforceGates(tt, classification.subIntent, evidence, { query: userText, schoolNamed });
  if (!gate.allowed) {
    const msg = noSourceLookupMessage({ subIntent: classification.subIntent, school: schoolName, locale, onDemand });
    const source = gate.fallback?.suggestedSource || null;
    return {
      block: true,
      response: {
        answer: msg,
        claims: [],
        limitations: [locale === "ko" ? "확인된 공식 출처가 없는 수치는 제시하지 않습니다." : "No figure is quoted without a verified official source."],
        actions: source?.url ? [{ label: source.label, url: source.url }] : [],
        usage: { input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
        content: [{ type: "text", text: msg }],
        _meta: { deterministic: true, topicType: tt, gates: gate.gates, modelTier: "NONE", noVerifiedSource: true, onDemandRead: onDemand },
      },
    };
  }
  return { systemPrefix: buildSystemPrompt(classification) };
}

export async function scoutSchoolOnDemand(schoolName, { timeoutMs = 15_000 } = {}) {
  const row = deps.resolveBaselineCollegeRow(deps.db, { schoolName });
  const target = { name: row?.name || schoolName, unitId: row?.unit_id || null, website: row?.website || null };
  const key = slugifyCollege(target.name) || String(target.name).toLowerCase();
  if (!deps.onDemandScouts.has(key)) {
    const run = scoutSchool(target, { stmts: deps.policyScoutStmts, factStmts: deps.factStmts, scorecardKey: deps.SCORECARD_API_KEY || null })
      .catch((err) => { console.warn("[policy-scout] on-demand read failed:", err?.message); return { status: "error" }; })
      .finally(() => deps.onDemandScouts.delete(key));
    deps.onDemandScouts.set(key, run);
  }
  const result = await Promise.race([
    deps.onDemandScouts.get(key),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref()),
  ]);
  if (!result) return "timeout";
  if (["skipped", "failed", "error"].includes(result.status)) return result.status;
  return "ok";
}

export async function scorecardStatsOnDemand(schoolName) {
  if (!deps.SCORECARD_API_KEY) return null;
  try {
    const wanted = expandCollegeAlias(schoolName);
    const hit = pickScorecardHit((await searchScorecard(deps.SCORECARD_API_KEY, { name: wanted, limit: 20 }))?.results, wanted);
    if (!hit) return null;
    const parts = [];
    const rate = Number(hit.acceptanceRate);
    if (Number.isFinite(rate) && rate > 0) parts.push(`admission rate ${Math.round(rate <= 1 ? rate * 100 : rate)}%`);
    if (hit.sat25 && hit.sat75) parts.push(`SAT middle 50% ${hit.sat25}–${hit.sat75}`);
    if (hit.act25 && hit.act75) parts.push(`ACT middle 50% ${hit.act25}–${hit.act75}`);
    if (!parts.length) return null;
    return {
      message: `${hit.name || wanted} — College Scorecard (U.S. Department of Education, latest reported year): ${parts.join("; ")}.`,
      source_url: "https://collegescorecard.ed.gov/",
      source_title: "College Scorecard (U.S. Department of Education)",
      confidence: "verified",
      trust_level: "official",
      advisory: "These are the latest figures the Department of Education reports; the school's own Common Data Set may be a year newer.",
    };
  } catch (err) {
    console.warn("[chat] Scorecard lookup failed:", err?.message);
    return null;
  }
}

// Parse the latest profile snapshot into a clean object for LLM prompts.
// PII-light: names/descriptions of the student's OWN activities/courses are
// their own data (no third-party PII); paid calls use the administrator's
// fixed OpenRouter key and the student's monthly budget ledger.
export function assembleProfileForGeneration(studentId) {
  const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
  if (!snap) return null;
  const profile = snap.profile_json ? safeParseJSON(snap.profile_json, {}) : {};
  return {
    gpaUnweighted: snap.gpa_unweighted ?? profile?.gpa?.unweighted ?? null,
    gpaWeighted: snap.gpa_weighted ?? profile?.gpa?.weighted ?? null,
    classRank: safeParseJSON(snap.class_rank_json, null),
    courses: safeParseJSON(snap.courses_json, []),
    apScores: safeParseJSON(snap.ap_scores_json, []),
    testScores: safeParseJSON(snap.test_scores_json, []),
    activities: safeParseJSON(snap.activities_json, []),
    majorInterest: snap.major_interest || profile?.majorInterest || null,
    goals: safeParseJSON(snap.goals_json, []),
  };
}

// The student's record against one school's enrolled class — the same
// reads the College Fit calculation makes (tests by section, GPA, class
// rank, AP exams) from the stored Common Data Set and baseline row, with no
// live fetch — so the priorities matrix under the fit card can place a
// score against the school's middle 50% instead of only listing it. Null
// when nothing is held for the school.
export function profileComparisonForSchool(studentId, schoolName) {
  try {
    if (!schoolName) return null;
    const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
    if (!snap) return null;
    const wanted = expandCollegeAlias(String(schoolName));
    const collegeRow = deps.resolveBaselineCollegeRow(deps.db, { schoolName: wanted });
    const record = resolveStoredCdsRecord(deps.ragStmts, { schoolName: collegeRow?.name || wanted });
    if (!record && !collegeRow) return null;
    // A usable record (validated, or the school's own current document
    // reading consistently) supplies the numbers; only an externally
    // checked one counts as verified for the confidence read.
    const validated = record ? isCdsRecordValidated(deps.ragStmts, record.slug) : false;
    const verification = record ? cdsVerification(deps.ragStmts, record.slug) : "unverified";
    const cds = record ? cdsRecordToPositioningResult(record, { validated: verification === "validated", verification }) : null;
    const pick = (cdsVal, baseVal) => (record && validated ? (cdsVal ?? baseVal) : (baseVal ?? cdsVal));
    const college = {
      name: collegeRow?.name || record?.school || wanted,
      sat25: pick(record?.enrolledSAT?.p25, collegeRow?.sat_25) ?? null,
      sat75: pick(record?.enrolledSAT?.p75, collegeRow?.sat_75) ?? null,
      act25: pick(record?.enrolledACT?.p25, collegeRow?.act_25) ?? null,
      act75: pick(record?.enrolledACT?.p75, collegeRow?.act_75) ?? null,
      avgGpaAdmitted: pick(record?.enrolledGPA?.avg, collegeRow?.avg_gpa_admitted) ?? cds?.parsed?.gpaAverage ?? null,
    };
    const strengthRows = deps.ragStmts.strength.getByStudent.all(studentId);
    const student = buildStudentModel({
      gpa_unweighted: snap.gpa_unweighted,
      gpa_weighted: snap.gpa_weighted,
      courses_json: snap.courses_json,
      test_scores_json: snap.test_scores_json,
      ap_scores_json: snap.ap_scores_json,
      class_rank_json: snap.class_rank_json,
      activities_json: snap.activities_json,
      major_interest: snap.major_interest,
    }, strengthRows, getActiveNarrative(deps.ragStmts.narrative, studentId));
    const gpa = compareGpaToSchool(student, college, cds);
    return buildProfileComparison({
      tests: compareTestsToSchool(student, college, cds),
      gpa,
      classRank: compareRankToSchool(student, cds),
      apExams: compareApExams(student),
      rigor: compareCourseRigor(student, gpa.average),
    });
  } catch (err) {
    console.warn("[COLLEGE-VALUES] profile comparison skipped:", err?.message);
    return null;
  }
}

// What the priorities matrix reads beyond courses and activities: the
// student's EC strength vectors (the character profile of each activity)
// and the placement of their scores against this school.
export function fitMatrixOptions(studentId, schoolName) {
  let strengthRows = [];
  try { strengthRows = deps.ragStmts.strength.getByStudent.all(studentId) || []; } catch { strengthRows = []; }
  return { strengthRows, comparison: profileComparisonForSchool(studentId, schoolName), schoolName: schoolName || null };
}

// Names of every baseline college, cached for the per-turn school-mention
// scan (the table only changes at boot).
export let baselineNameCache = { at: 0, names: [] };

export function baselineCollegeNames() {
  if (Date.now() - baselineNameCache.at > 10 * 60 * 1000) {
    try {
      baselineNameCache = { at: Date.now(), names: deps.db.prepare("SELECT name FROM baseline_colleges").all().map((r) => r.name) };
    } catch {
      baselineNameCache = { at: Date.now(), names: [] };
    }
  }
  return baselineNameCache.names;
}

// The VERIFIED DATA block for a chat turn, from local data only — no live
// Scorecard or CDS fetches (those belong to College Fit, where the latency is
// expected). Schools named in the question come first; the student's target
// schools are added for college-fit / strategy / supervisor calls.
export function buildVerifiedDataContext({ questionText, studentId, evidence = [], wantsCollegeData = false }) {
  const knownNames = [...baselineCollegeNames(), ...fitReadsForStudent(studentId).map((r) => r.school)];
  const names = detectSchoolMentions(questionText, { knownNames });
  if (wantsCollegeData) {
    for (const target of deps.resolveTargetSchools(studentId)) {
      const canonical = detectSchoolMentions(target, { knownNames, max: 1 })[0] || target;
      if (!names.some((n) => schoolNamesCompatible(n, canonical))) names.push(canonical);
    }
  }
  const schools = [];
  const fitReads = fitReadsForStudent(studentId);
  for (const name of names.slice(0, 8)) {
    const row = deps.resolveBaselineCollegeRow(deps.db, { schoolName: name });
    const cds = resolveStoredCdsRecord(deps.ragStmts, { schoolName: row?.name || name });
    const fitRead = fitReads.find((r) => schoolNamesCompatible(r.school, row?.name || name)) || null;
    // A school known only through the policy scout — typically an on-demand
    // read of its admissions pages for a deadline question — still has
    // verified data worth citing (its plan deadlines and test policy).
    let snapshot = null;
    try { snapshot = readPolicySnapshot(deps.policyScoutStmts, { unitId: row?.unit_id, name: row?.name || cds?.school || name }); } catch { snapshot = null; }
    if (!row && !cds && !fitRead && !snapshot) continue;
    const resolvedName = row?.name || cds?.school || fitRead?.school || snapshot?.school || name;
    if (schools.some((s) => schoolNamesCompatible(s.name, resolvedName))) continue;
    let policyLine = null;
    try { policyLine = snapshot ? formatPolicyLine(snapshot) : null; } catch { policyLine = null; }
    schools.push({
      name: resolvedName,
      state: row?.state || null,
      baseline: row,
      cds,
      cdsValidated: cds ? isCdsRecordValidated(deps.ragStmts, cds.slug) : false,
      policyLine,
      // The student's own College Fit read (and its web double-check), so
      // the counselor quotes the same label the card shows.
      fitRead,
    });
    if (schools.length >= 4) break;
  }
  const facts = (Array.isArray(evidence) ? evidence : [])
    .filter((f) => String(f?.confidence || "").toLowerCase() === "verified" && (f.source_url || f.source_domain))
    .slice(0, 5);
  return formatVerifiedDataBlock({ schools, facts });
}

// True when the question names a school we hold official data for, so an
// exact-lookup question can be answered from the VERIFIED DATA block.
export function hasVerifiedCollegeData(questionText) {
  try {
    for (const name of detectSchoolMentions(questionText, { knownNames: baselineCollegeNames() })) {
      const row = deps.resolveBaselineCollegeRow(deps.db, { schoolName: name });
      if (row && (row.acceptance_rate != null || row.sat_25 != null)) return true;
      if (resolveStoredCdsRecord(deps.ragStmts, { schoolName: row?.name || name })) return true;
      if (readPolicySnapshot(deps.policyScoutStmts, { unitId: row?.unit_id, name: row?.name || name })) return true;
    }
  } catch { /* fall back to the gate */ }
  return false;
}

export function regulatedResultForChat(classification, payload) {
  const subIntent = String(classification?.subIntent || "").toLowerCase();
  if (subIntent.includes("fafsa") || subIntent.includes("eligibility")) {
    return runFAFSAEligibilityCheck(payload.fafsa_profile || payload.student_data || {});
  }
  if (subIntent.includes("deadline")) {
    return calculateDeadlineStatus(
      payload.deadline || payload.deadline_date || null,
      payload.application_type || "regular_decision",
    );
  }
  return {
    message: "No deterministic rule is available for this regulated question.",
    advisory: "Use the official source or a qualified school counselor before acting on this information.",
  };
}

// Answer a chat deadline question from the official-source research cache
// when the query names schools whose admissions pages have been researched
// (see college-research.js). Returns null when nothing cached matches.
// `current: true` ignores a snapshot read by an older scout version, so the
// caller reads the school's pages again before answering from it.
export function deadlinesFromResearchCache(userText, { current = false } = {}) {
  let names = [];
  // Schools named in the question (aliases + baseline names). This used to
  // pass the question STRING to extractTargetSchoolNames, which iterates a
  // goals array — so it "found" single characters and never matched a school.
  try { names = detectSchoolMentions(userText, { knownNames: baselineCollegeNames() }); } catch { return null; }
  const found = [];
  for (const name of names.slice(0, 3)) {
    let record = readCachedDeadlines(deps.collegeResearchStmts, name);
    if (!record) {
      // The daily policy scout reads the same official pages; its snapshot
      // stands in when no model-researched record is cached.
      try {
        const snapshot = readPolicySnapshot(deps.policyScoutStmts, { name });
        record = snapshot && (!current || snapshotIsCurrent(snapshot)) ? snapshotAsDeadlineRecord(snapshot) : null;
      } catch { record = null; }
    }
    if (record) found.push(record);
  }
  if (!found.length) return null;
  const labels = {
    ea: "Early Action", ed: "Early Decision", edII: "Early Decision II", rd: "Regular Decision",
    financialAid: "Financial aid priority", commitBy: "Commit by", decisionRelease: "RD decisions",
  };
  const lines = found.map((record) => {
    const parts = Object.entries(labels)
      .map(([key, label]) => record.deadlines?.[key] ? `${record.labels?.[key] || label}: ${record.deadlines[key]}` : null)
      .filter(Boolean).join(" · ");
    return `${record.displayName} (${record.cycle} cycle): ${parts}`;
  });
  const first = found[0];
  // The student may ask for one plan the pages do not state (NJIT's site
  // gives an Early Action date and admits on a rolling basis after it). Say
  // so instead of answering a different question with the dates on file.
  const asked = /\bregular\s+(?:decision|action)\b|\bRD\b/i.test(userText) ? "rd"
    : /\bearly\s+decision\s+(?:ii|2)\b|\bED\s?(?:II|2)\b/i.test(userText) ? "edII"
      : /\bearly\s+decision\b|\bED\b/i.test(userText) ? "ed"
        : /\b(?:restrictive\s+)?early\s+action\b|\bR?EA\b/i.test(userText) ? "ea" : null;
  const missingPlan = asked && !first.deadlines?.[asked] ? asked : null;
  const note = missingPlan
    ? ` The pages read do not state a ${labels[missingPlan]} deadline for ${first.displayName}${missingPlan === "rd" ? " (some schools admit on a rolling basis after Early Action)" : ""} — check the linked admissions page.`
    : "";
  return {
    message: lines.join("\n") + note,
    source_url: first.sourceUrl,
    source_title: `${first.displayName} official admissions pages`,
    confidence: "verified",
    trust_level: "official",
    advisory: `Dates were read from the school's own admissions pages on ${String(first.extractedAt || "").slice(0, 10)}. Confirm on the linked page before relying on them.`,
  };
}
