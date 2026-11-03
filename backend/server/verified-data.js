// server/verified-data.js — the VERIFIED DATA block and the official-source
// gate around it: the on-demand reads of a school's own pages and the College
// Scorecard, the profile comparison, the College Fit reads, and the deadlines
// held in the research cache. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (SCORECARD_API_KEY, collegeResearchStmts, db,
// evidenceStmts, factStmts, fitReadStmts, onDemandScouts, policyScoutStmts,
// ragStmts, resolveBaselineCollegeRow, resolveTargetSchools).
import { expandCollegeAlias, pickScorecardHit, readCachedDeadlines, slugifyCollege } from "../colleges/college-research.js";
import { safeParseJSON } from "./model-calls.js";
import { TOPIC_TYPES, enforceGates } from "../chat/policy-router.js";
import { buildSystemPrompt } from "../chat/orchestration-engine.js";
import { searchFacts } from "../scouts/fact-store.js";
import { getEvidenceProfile } from "../storage/evidence-graph.js";
import { formatPolicyLine, makeFetcher, readPolicySnapshot, scoutSchool, snapshotAsDeadlineRecord, snapshotIsCurrent } from "../scouts/admissions-policy-scout.js";
import { searchScorecard } from "../colleges/college-scorecard.js";
import { assertSafeFetchTarget } from "../security/safe-fetch.js";
import { isCdsRecordValidated, resolveStoredCdsRecord, schoolNamesCompatible } from "../cds/cds-store.js";
import { POSITIONING_MODEL_VERSION, buildProfileComparison, buildStudentModel, scoreAcademicReadiness } from "../colleges/positioning-engine.js";
import { localFitContext } from "./fit-context.js";
import { getActiveNarrative } from "../activities/narrative-store.js";
import { detectSchoolMentions, formatVerifiedDataBlock, unresolvedSchoolNames } from "../chat/chat-grounding.js";
import { calculateDeadlineStatus, runFAFSAEligibilityCheck } from "../chat/rules-engine.js";

let deps;
export function bindVerifiedData(serverDeps) { deps = serverDeps; }

function latestSnapshotId(studentId) {
  try { return deps.ragStmts.getLatestSnapshot.get(studentId)?.id ?? null; } catch { return null; }
}

// The student's College Fit read for a school, kept for the chat's
// VERIFIED DATA block. The stored provenance carries what the read was
// computed from (the profile snapshot and the engine version) and its
// label key, so a later reader can tell a current read from an old one.
//
// A read the engine withheld a label from ("insufficient_student_data")
// stores no label: the chat was told "use this exact label" for a "Reach"
// computed from an empty record (fit-4).
//
// The double-check stays beside a read only while it describes that read:
// the same label from the same snapshot and engine. The upsert keeps the
// previous verification when a plain re-read passes none (server.js), so a
// new "Competitive" read sat beside October's "with live inputs the read
// moves to High reach" (fit-9). When the read moved, an explicit JSON null
// is written, which the upsert takes in place of the old verdict.
export function rememberFitRead(studentId, target, { verification = null, snapshotId = undefined } = {}) {
  try {
    const slug = slugifyCollege(target?.schoolName || "");
    if (!slug) return;
    const withheld = String(target?.labelKey || "").startsWith("insufficient_");
    const label = withheld ? null : (target.overallPositioningLabel || null);
    const snapshot = snapshotId !== undefined ? snapshotId : latestSnapshotId(studentId);
    const provenance = {
      ...(target.dataProvenance || {}),
      labelKey: target.labelKey ?? target.dataProvenance?.labelKey ?? null,
      modelVersion: POSITIONING_MODEL_VERSION,
      snapshotId: snapshot ?? null,
    };
    let verificationJson = verification ? JSON.stringify(verification) : null;
    if (!verification) {
      const previous = (deps.fitReadStmts.byStudent.all(studentId) || []).find((row) => row.slug === slug) || null;
      if (previous?.verification_json && previous.verification_json !== "null") {
        const before = safeParseJSON(previous.provenance_json, null) || {};
        const sameRead = previous.label === label
          && before.modelVersion === POSITIONING_MODEL_VERSION
          && String(before.snapshotId ?? "") === String(snapshot ?? "");
        if (!sameRead) verificationJson = "null";
      }
    }
    deps.fitReadStmts.upsert.run(
      studentId, slug, target.schoolName, label, withheld ? null : (target.finalPositioningScore ?? null),
      target.admissibility?.academicReadinessScore ?? null, target.competitiveness?.majorCompetitivenessScore ?? null,
      target.fit?.institutionalPriorityFitScore ?? null, target.confidence?.evidenceConfidence || null,
      JSON.stringify(provenance), verificationJson,
      new Date().toISOString(),
    );
  } catch (err) { console.warn("[fit-read] not saved:", err?.message); }
}

// The stored reads, each marked stale when it was computed by another
// engine version or from an older profile snapshot. A stale read gives no
// label (the chat's fit line needs one) and no double-check: rows written
// before a version bump kept their old labels in the chat until the student
// reopened that school (fit-9). `staleLabel` keeps what it said.
export function fitReadsForStudent(studentId) {
  try {
    const currentSnapshot = latestSnapshotId(studentId);
    return deps.fitReadStmts.byStudent.all(studentId).map((row) => {
      const provenance = safeParseJSON(row.provenance_json, null);
      const stale = provenance?.modelVersion !== POSITIONING_MODEL_VERSION
        || (currentSnapshot != null && String(provenance?.snapshotId ?? "") !== String(currentSnapshot));
      return {
        school: row.school, slug: row.slug,
        label: stale ? null : row.label,
        score: stale ? null : row.score,
        admissibility: row.admissibility, competitiveness: row.competitiveness, fit: row.fit,
        confidence: row.confidence, provenance,
        verification: stale ? null : safeParseJSON(row.verification_json, null), computedAt: row.computed_at,
        stale,
        staleLabel: stale ? row.label : null,
        labelKey: stale ? null : (provenance?.labelKey ?? null),
      };
    });
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
  const rules = fafsaRuleTextForPrompt(userText, classification.subIntent);
  return { systemPrefix: [buildSystemPrompt(classification), rules].filter(Boolean).join("\n\n") };
}

// The official rule text beside a FAFSA eligibility question the checklist
// does not answer on its own (gate-9): "Am I eligible as a permanent
// resident?" and "my parents are undocumented" went to the canned checklist
// and were never addressed. They now reach the model as labeled general
// guidance with the reviewed rules to cite, and an honest pointer for what
// the rules do not settle. Nothing when no reviewed ruleset covers `now`:
// the advisory prefix and the StudentAid.gov pointer stand alone.
const FAFSA_RULES_TOPIC_RE = /\b(?:eligib\w*|qualif\w*|citizen\w*|residents?|green\s+card|daca|undocumented|non-?citizens?|ssn|social\s+security|visas?|immigra\w*|refugees?|asylum)\b|자격|영주권|시민권|체류|비자|사회\s*보장/i;

export function fafsaRuleTextForPrompt(questionText, subIntent, { now = new Date() } = {}) {
  const intent = String(subIntent || "").toLowerCase();
  if (intent !== "eligibility" && !(intent === "fafsa" && FAFSA_RULES_TOPIC_RE.test(String(questionText || "")))) return "";
  const check = runFAFSAEligibilityCheck({}, { now });
  if (check.available === false) return "";
  const lines = check.results.map((rule) => `- ${rule.label}: ${rule.description}${rule.note ? ` ${rule.note}` : ""} [Source: ${rule.source}]`);
  for (const removed of check.removedRequirements || []) lines.push(`- ${removed.note} [Source: ${removed.source}]`);
  return `OFFICIAL FAFSA ELIGIBILITY RULES (${check.sourceTitle}, for the ${check.academicYear} award year; reviewed text, not a determination). Answer the student's own situation from these where they apply and cite the source. For a case they do not settle (a parent or contributor without a Social Security number, a particular immigration status), say so plainly and send the student to studentaid.gov/apply-for-aid/fafsa/eligibility instead of guessing.${check.filingYearNote ? ` ${check.filingYearNote}` : ""}\n${lines.join("\n")}`;
}

// What `orAbort` resolves to when the signal fires first.
const ABORTED = Symbol("aborted");

// The promise's value, or ABORTED as soon as `signal` aborts. The promise
// keeps its handlers, so a rejection after the abort is not left unhandled.
function orAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  let onAbort = null;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

// An on-demand read of a school's own pages, shared by every chat turn that
// asks about that school while it runs (deps.onDemandScouts, by slug). Each
// turn waits under its own signal (chat-11): one whose student cancelled or
// timed out stops waiting at once ("aborted") instead of holding the request
// for up to 15 s, and when the last turn waiting has gone that way the page
// reads stop too. A wait that only times out leaves the read running, as it
// always has, so the snapshot it writes answers the next question.
export async function scoutSchoolOnDemand(schoolName, { timeoutMs = 15_000, signal = null } = {}) {
  if (signal?.aborted) return "aborted";
  const row = deps.resolveBaselineCollegeRow(deps.db, { schoolName });
  const target = { name: row?.name || schoolName, unitId: row?.unit_id || null, website: row?.website || null };
  const key = slugifyCollege(target.name) || String(target.name).toLowerCase();
  let entry = deps.onDemandScouts.get(key);
  if (!entry) {
    const controller = new AbortController();
    // The scout's own fetcher (robots.txt, the per-host delay, the safe-fetch
    // target check), with the run's signal joined to each page's timeout.
    // Once it aborts, every later page is refused at the target check, ahead
    // of the per-host delay, so the run ends instead of walking its list.
    const fetcher = makeFetcher({
      assertTarget: (url) => {
        controller.signal.throwIfAborted();
        return assertSafeFetchTarget(url);
      },
      fetchImpl: (url, init = {}) => globalThis.fetch(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      }),
    });
    const created = { controller, waiters: 0, run: null };
    created.run = scoutSchool(target, { stmts: snapshotWritesUntilAborted(deps.policyScoutStmts, controller.signal), factStmts: deps.factStmts, scorecardKey: deps.SCORECARD_API_KEY || null, fetcher })
      .catch((err) => {
        if (controller.signal.aborted) return { status: "aborted" };
        console.warn("[policy-scout] on-demand read failed:", err?.message);
        return { status: "error" };
      })
      .finally(() => { if (deps.onDemandScouts.get(key) === created) deps.onDemandScouts.delete(key); });
    deps.onDemandScouts.set(key, created);
    entry = created;
  }
  entry.waiters += 1;
  let timer = null;
  try {
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
    const result = await orAbort(Promise.race([entry.run, timedOut]), signal);
    if (result === ABORTED) return "aborted";
    if (!result) return "timeout";
    if (["skipped", "failed", "error", "aborted"].includes(result.status)) return result.status;
    return "ok";
  } finally {
    clearTimeout(timer);
    entry.waiters -= 1;
    if (signal?.aborted && entry.waiters === 0) {
      entry.controller.abort(new Error("Every chat turn waiting on this read has closed."));
      // A turn that arrives now starts its own read rather than joining one
      // that will store nothing.
      if (deps.onDemandScouts.get(key) === entry) deps.onDemandScouts.delete(key);
    }
  }
}

// The policy scout's statements for one on-demand read, with the snapshot
// writes refused once the read is stopped. The fetcher answers a stopped
// page as "no page", so a read cut off part-way still returned the pages it
// had and scoutSchool stored that partial reading as the school's current
// snapshot: the dates on the pages never read were gone for every student
// until the cycle turned, since a current snapshot is never re-read on
// demand (backend-1). The snapshot is the first write and the change rows
// and facts follow it in the same tick, so refusing it refuses them all.
function snapshotWritesUntilAborted(stmts, signal) {
  if (!stmts) return stmts;
  const gated = (stmt) => stmt && {
    run: (...args) => {
      signal.throwIfAborted();
      return stmt.run(...args);
    },
  };
  return { ...stmts, upsertSnapshot: gated(stmts.upsertSnapshot), insertChange: gated(stmts.insertChange) };
}

// The Scorecard's figures for one school. A turn whose student went away
// stops waiting (null, as if nothing were found); the search's own request
// is held to its 10 s timeout inside searchScorecard.
export async function scorecardStatsOnDemand(schoolName, { signal = null } = {}) {
  if (!deps.SCORECARD_API_KEY || signal?.aborted) return null;
  try {
    const wanted = expandCollegeAlias(schoolName);
    const found = await orAbort(searchScorecard(deps.SCORECARD_API_KEY, { name: wanted, limit: 20, signal }), signal);
    if (found === ABORTED) return null;
    const hit = pickScorecardHit(found?.results, wanted);
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
//
// The grade level is the server's own (getStudentGrade, from the class the
// student registered with), never one the client sends: the model could not
// tell a freshman from a senior (fid-5). The GPA and testing statuses ride
// along when the snapshot stores them. A read of `snap.profile_json` used
// to sit here; profile_snapshots has no such column, so it never fired.
export function assembleProfileForGeneration(studentId) {
  const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
  if (!snap) return null;
  let gradeLevel = null;
  try { gradeLevel = deps.authStore?.getStudentGrade?.(studentId) ?? null; } catch { gradeLevel = null; }
  return {
    gradeLevel,
    gpaStatus: snap.gpa_status ?? null,
    testingStatus: snap.testing_status ?? null,
    gpaUnweighted: snap.gpa_unweighted ?? null,
    gpaWeighted: snap.gpa_weighted ?? null,
    classRank: safeParseJSON(snap.class_rank_json, null),
    courses: safeParseJSON(snap.courses_json, []),
    apScores: safeParseJSON(snap.ap_scores_json, []),
    testScores: safeParseJSON(snap.test_scores_json, []),
    activities: safeParseJSON(snap.activities_json, []),
    majorInterest: snap.major_interest || null,
    goals: safeParseJSON(snap.goals_json, []),
  };
}

// The student's record against one school's enrolled class — the same
// reads the College Fit calculation makes (tests by section, GPA, class
// rank, AP exams, course load) from the same school context the card uses
// (server/fit-context.js: the stored Common Data Set and baseline row, the
// admit rate, the policy the school states this cycle), with no live
// fetch — so the priorities matrix under the fit card places a score where
// the card does. Null when nothing is held for the school.
export function profileComparisonForSchool(studentId, schoolName) {
  try {
    if (!schoolName) return null;
    const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
    if (!snap) return null;
    const wanted = expandCollegeAlias(String(schoolName));
    const context = localFitContext(deps, schoolName, { wanted });
    if (!context) return null;
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
    // The readiness reads themselves, as buildPositioningForTarget takes
    // them: the GPA average falls back to what the admit rate implies, and
    // the rigor expectation follows it.
    return buildProfileComparison(scoreAcademicReadiness(student, context.collegeContext, context.cdsForRead).reads);
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
  // Schools the question names that nothing is held for get a line saying
  // so (fid-10): with no line the model answered from memory. Only the
  // question's own names; a target school with no data is not news.
  const asked = new Set(names.map((n) => n.toLowerCase()));
  if (wantsCollegeData) {
    for (const target of deps.resolveTargetSchools(studentId)) {
      const canonical = detectSchoolMentions(target, { knownNames, max: 1 })[0] || target;
      if (!names.some((n) => schoolNamesCompatible(n, canonical))) names.push(canonical);
    }
  }
  const schools = [];
  const fitReads = fitReadsForStudent(studentId);
  const unheld = [];
  for (const name of names.slice(0, 8)) {
    const row = deps.resolveBaselineCollegeRow(deps.db, { schoolName: name });
    const cds = resolveStoredCdsRecord(deps.ragStmts, { schoolName: row?.name || name });
    const fitRead = fitReads.find((r) => schoolNamesCompatible(r.school, row?.name || name)) || null;
    // A school known only through the policy scout — typically an on-demand
    // read of its admissions pages for a deadline question — still has
    // verified data worth citing (its plan deadlines and test policy).
    let snapshot = null;
    try { snapshot = readPolicySnapshot(deps.policyScoutStmts, { unitId: row?.unit_id, name: row?.name || cds?.school || name }); } catch { snapshot = null; }
    if (!row && !cds && !fitRead && !snapshot) {
      if (asked.has(name.toLowerCase())) unheld.push(name);
      continue;
    }
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
  // A college name the alias table and the baseline names both miss ("Elm
  // Valley College") is unheld too, unless the baseline resolver knows it
  // under another spelling.
  for (const name of unresolvedSchoolNames(questionText, { knownNames })) {
    let row = null;
    try { row = deps.resolveBaselineCollegeRow(deps.db, { schoolName: name }); } catch { row = null; }
    if (!row) unheld.push(name);
  }
  const facts = (Array.isArray(evidence) ? evidence : [])
    .filter((f) => String(f?.confidence || "").toLowerCase() === "verified" && (f.source_url || f.source_domain))
    .slice(0, 5);
  return formatVerifiedDataBlock({ schools, facts, unheld });
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

// A FAFSA eligibility question reaches this only as a plain checklist
// question (policy-router canHandleDeterministically). When no reviewed
// ruleset covers `now` the check answers "No deterministic rule is
// available", which the route reads as not answerable here: the question
// goes to the model under the regulated advisory prefix instead of an empty
// verified lane.
export function regulatedResultForChat(classification, payload, { now = new Date() } = {}) {
  const subIntent = String(classification?.subIntent || "").toLowerCase();
  if (subIntent.includes("fafsa") || subIntent.includes("eligibility")) {
    return runFAFSAEligibilityCheck(payload.fafsa_profile || payload.student_data || {}, { now });
  }
  if (subIntent.includes("deadline")) {
    return calculateDeadlineStatus(
      payload.deadline || payload.deadline_date || null,
      payload.application_type || "regular_decision",
      { now },
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
