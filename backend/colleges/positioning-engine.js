import { clamp01, matchMajorBucketStrict } from "../activities/vector-utils.js";
import { normalizeClassRank, sectionEntries } from "../academics/test-catalog.js";
import { chooseTestSitting } from "../academics/test-sittings.js";
import { readCourseRigor } from "../academics/course-rigor.js";
import { apExamKey, apNameWords } from "../academics/ap-exams.js";
import { cycleAge } from "../cds/cds-cycle.js";

export const C7_RATING_VALUES = Object.freeze({
  very_important: 1,
  important: 0.7,
  considered: 0.35,
  not_considered: 0,
});

export const MAJOR_DEMAND_BASE = Object.freeze({
  computer_science: 0.92,
  data_science: 0.88,
  computational_biology: 0.82,
  biomedical_engineering: 0.8,
  engineering: 0.78,
  business: 0.74,
  economics: 0.7,
  biology: 0.69,
  neuroscience: 0.72,
  chemistry: 0.62,
  physics: 0.58,
  mathematics: 0.56,
  political_science: 0.55,
  international_relations: 0.57,
  public_policy: 0.6,
  journalism: 0.5,
  english: 0.48,
  music: 0.46,
  art: 0.45,
  theater: 0.44,
  education: 0.47,
  public_health: 0.66,
  environmental_science: 0.63,
});

// MVP proxy until full CIP-driven IPEDS ingest lands.
export const IPEDS_CIP_GROWTH_PROXY = Object.freeze({
  computer_science: 0.86,
  data_science: 0.84,
  computational_biology: 0.74,
  biomedical_engineering: 0.72,
  engineering: 0.7,
  business: 0.62,
  economics: 0.54,
  biology: 0.52,
  neuroscience: 0.64,
  chemistry: 0.42,
  physics: 0.38,
  mathematics: 0.4,
  public_health: 0.71,
  environmental_science: 0.6,
});

const MAJOR_KEYWORDS = Object.freeze({
  // Calculus, linear algebra and discrete mathematics are what a computer
  // science department asks for first; without them a student with AP CS A,
  // Calculus BC and Physics C read "without enough preparation".
  computer_science: ["computer science", "cs", "programming", "software", "data structures", "algorithms", "machine learning", "python", "java", "javascript", "ap computer science", "calculus", "linear algebra", "discrete"],
  data_science: ["data science", "statistics", "data", "analytics", "ap statistics", "probability"],
  computational_biology: ["biology", "bioinformatics", "genomics", "computational", "biostatistics", "ap biology"],
  biomedical_engineering: ["engineering", "biomedical", "physics", "biology", "calculus"],
  engineering: ["engineering", "physics", "calculus", "mechanics", "robotics", "cad"],
  business: ["business", "economics", "finance", "accounting", "entrepreneurship", "deca", "fbla"],
  economics: ["economics", "microeconomics", "macroeconomics", "statistics", "finance"],
  biology: ["biology", "ap biology", "chemistry", "anatomy", "physiology"],
  chemistry: ["chemistry", "ap chemistry", "organic", "lab"],
  physics: ["physics", "ap physics", "mechanics", "electricity", "magnetism"],
  mathematics: ["math", "calculus", "statistics", "linear algebra", "number theory"],
  political_science: ["government", "politics", "ap government", "history", "debate"],
  international_relations: ["international", "government", "history", "foreign policy", "model un"],
  public_policy: ["policy", "government", "economics", "statistics", "debate"],
  journalism: ["journalism", "newspaper", "writing", "english"],
  english: ["english", "literature", "writing", "composition"],
  education: ["education", "teaching", "psychology", "child development"],
  public_health: ["public health", "biology", "statistics", "chemistry"],
  environmental_science: ["environmental", "biology", "chemistry", "geography"],
  // The buckets added with the strict matcher (2026-11-03); these majors
  // used to be read as computer science.
  nursing: ["biology", "chemistry", "anatomy", "physiology", "health", "psychology"],
  pre_law: ["government", "history", "debate", "english", "writing", "law"],
  communications: ["english", "writing", "journalism", "speech", "media", "communication"],
  sociology: ["sociology", "psychology", "statistics", "history", "government"],
});

function round1(x) {
  return Math.round(Number(x || 0) * 10) / 10;
}

function round2(x) {
  return Math.round(Number(x || 0) * 100) / 100;
}

function round4(x) {
  return Math.round(Number(x || 0) * 10000) / 10000;
}

function avg(values) {
  const nums = (values || []).map(Number).filter((n) => Number.isFinite(n));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

// Maximum half-width (in score points) of the uncertainty band shown when
// evidence confidence is at its floor. At full confidence the band collapses
// to the point estimate; at zero confidence a displayed score spreads ±this.
const CONFIDENCE_BAND_MAX_HALFWIDTH = 18;

// Turn a point score + normalized evidence confidence (0..1) into an honest
// display band. Low evidence → wide band, so a thin-data "73" is shown as a
// range (e.g. 58–88) instead of a crisp number it does not deserve.
function confidenceBand(score, confidenceNormalized) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const c = clamp01(Number(confidenceNormalized ?? 0.5));
  const halfWidth = (1 - c) * CONFIDENCE_BAND_MAX_HALFWIDTH;
  return {
    point: round1(s),
    low: round1(Math.max(0, s - halfWidth)),
    high: round1(Math.min(100, s + halfWidth)),
    halfWidth: round1(halfWidth),
  };
}

function normalizePercentValue(value) {
  // Guard null/undefined/"" explicitly: Number(null) === 0, which would
  // otherwise read a school with an UNKNOWN admit rate as 0% (maximally
  // selective) and wrongly apply a selectivity boost. Unknown must stay null.
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function c7RatingValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (normalized === "very_important" || normalized === "vi") return 1;
  if (normalized === "important" || normalized === "i") return 0.7;
  if (normalized === "considered" || normalized === "c") return 0.35;
  if (normalized === "not_considered" || normalized === "nc") return 0;
  return null;
}

function c7Value(c7, keys, fallback) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(c7 || {}, key)) {
      const value = c7RatingValue(c7[key]);
      if (value != null) return value;
    }
  }
  return fallback;
}

function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
}

function normalizeCourseName(course) {
  return String(course?.name || course?.title || course || "").toLowerCase();
}

function gradeToPoints(raw) {
  if (raw == null || raw === "") return null;
  const str = String(raw).trim().toUpperCase();
  if (/^\d+(\.\d+)?$/.test(str)) {
    const num = Number(str);
    if (num <= 4.5) return num;
    if (num >= 90) return 4;
    if (num >= 80) return 3;
    if (num >= 70) return 2;
    if (num >= 60) return 1;
    return 0;
  }
  if (str.startsWith("A")) return 4;
  if (str.startsWith("B")) return 3;
  if (str.startsWith("C")) return 2;
  if (str.startsWith("D")) return 1;
  if (str.startsWith("F")) return 0;
  return null;
}

// The intended major's bucket, or null when the student has none or names
// a field no rule knows. Null is read as neutral everywhere below (no
// major-specific demand, preparation weight, or red flags): the old default
// read every such student as a computer-science applicant (fit-1).
function getMajorKeywords(major) {
  const bucket = matchMajorBucketStrict(major || "");
  return { bucket, keywords: bucket ? (MAJOR_KEYWORDS[bucket] || []) : [] };
}

// A keyword names a course when it starts a word of the course name:
// "math" still counts "Mathematics", but "cs" no longer counts "Physics",
// "Economics" and "Politics" as computer-science coursework.
function wordStartPattern(keyword) {
  return new RegExp(`(?<![a-z0-9])${String(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
}

// { readingWriting: 720, math: 780 } from a stored test entry, or null.
function sectionMap(entry) {
  const out = {};
  for (const section of sectionEntries(entry)) out[section.key] = section.value;
  return Object.keys(out).length ? out : null;
}

// AP exam results as evidence of college-level mastery: how many, the
// average, the strong (4–5) and weak (1–2) counts, and the exams that speak
// to the intended major (whole-word keyword match, so "cs" never claims
// "Physics"). An exam is named as the AP catalog names it ("APUSH" is US
// History), and one taken twice counts once, at its better score: each
// sitting used to count as another exam in the count and the average.
function summarizeApExams(apScores, keywords = []) {
  const byExam = new Map();
  for (const a of Array.isArray(apScores) ? apScores : []) {
    const raw = String(a?.exam || a?.subject || a?.name || "").trim();
    const score = Number(a?.score);
    if (!raw || !Number.isFinite(score) || score < 1 || score > 5) continue;
    const name = apExamKey(raw) || raw;
    const id = apExamKey(raw) || apNameWords(raw);
    const held = byExam.get(id);
    if (!held || score > held.score) byExam.set(id, { name, score });
  }
  const exams = [...byExam.values()];
  const patterns = keywords.map((kw) => new RegExp(`(?<![a-z0-9])${String(kw).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i"));
  const relevant = exams.filter((a) => patterns.some((re) => re.test(a.name)));
  const average = avg(exams.map((a) => a.score));
  return {
    count: exams.length,
    average: average != null ? round1(average) : null,
    strong: exams.filter((a) => a.score >= 4).length,
    weak: exams.filter((a) => a.score <= 2).length,
    relevant: relevant.map((a) => ({ name: a.name, score: a.score })),
    relevantAverage: relevant.length ? round1(avg(relevant.map((a) => a.score))) : null,
  };
}

export function buildStudentModel(snapshot, strengthRows = [], narrative = null, context = {}) {
  const courses = Array.isArray(snapshot?.courses) ? snapshot.courses : safeJson(snapshot?.courses_json, []);
  const testScores = Array.isArray(snapshot?.testScores) ? snapshot.testScores : safeJson(snapshot?.test_scores_json, []);
  const activities = Array.isArray(snapshot?.activities) ? snapshot.activities : safeJson(snapshot?.activities_json, []);
  const majorInterest = snapshot?.majorInterest || snapshot?.major_interest || context.majorInterest || null;
  const { bucket: majorBucket, keywords } = getMajorKeywords(majorInterest);

  const gpa = Number(snapshot?.gpa?.unweighted ?? snapshot?.gpa_unweighted ?? snapshot?.gpaUnweighted ?? 0) || null;
  const weightedGpa = Number(snapshot?.gpa?.weighted ?? snapshot?.gpa_weighted ?? snapshot?.gpaWeighted ?? 0) || null;
  // What the GPA can be compared as. The profile records no GPA scale, and
  // the unweighted box accepts up to 5.0 because schools report on 4.0, 4.3
  // and 5.0 scales: a 4.52 typed there used to be read as a 4.0-scale GPA
  // above every school's average. Above 4.0 the scale is unknown and the
  // read does not place it on the 4.0 scale; a weighted GPA alone is
  // compared at most at 4.0 (compareGpaToSchool).
  const gpaBasis = gpa != null
    ? (gpa > 4 ? "scale_unknown" : "unweighted")
    : (weightedGpa != null ? "weighted_only" : "none");
  // The highest sitting of each test, its sections with it: the first entry
  // was the oldest, so a retake that raised the score was never read (fit-2).
  const satEntry = chooseTestSitting(testScores, "sat", { mode: "best" });
  const actEntry = chooseTestSitting(testScores, "act", { mode: "best" });
  const sat = Number(satEntry?.totalScore) || null;
  const act = Number(actEntry?.totalScore) || null;
  // Section scores (SAT Reading & Writing and Math; ACT English, Math,
  // Reading, Science) are compared with a school's section bands.
  const satSections = sectionMap(satEntry);
  const actSections = sectionMap(actEntry);
  // Class rank as the student's standing from the top; C10 of a Common
  // Data Set reports the enrolled class in the same terms.
  const classRank = normalizeClassRank(snapshot?.classRank ?? safeJson(snapshot?.class_rank_json, null));
  const rankPercentile = classRank?.topPercent != null
    ? Math.round((100 - classRank.topPercent) * 10) / 10
    : (Number(snapshot?.classRankPercentile ?? context.classRankPercentile ?? 0) || null);
  const apScores = Array.isArray(snapshot?.apScores) ? snapshot.apScores : safeJson(snapshot?.ap_scores_json, []);
  const apExams = summarizeApExams(apScores, keywords);

  const coursePatterns = keywords.map(wordStartPattern);
  const relevantCourses = courses.filter((course) => {
    const name = normalizeCourseName(course);
    return coursePatterns.some((re) => re.test(name));
  });
  // Course rigor: every college-level course by its type or its name, plus
  // the AP exams no listed course names, each AP weighted by its exam
  // score (course-rigor.js). Before this only courses typed AP/IB/dual
  // counted, so AP work recorded as exam results — or courses named "AP …"
  // but left typed regular — was no rigor at all.
  const rigor = readCourseRigor(courses, apScores);
  const rigorousCourseCount = rigor.collegeLevelCourses + rigor.apExamsWithoutCourse;
  const seniorRigorCount = rigor.seniorCollegeLevel;

  const majorRelevantGpa = avg(relevantCourses.map((course) => gradeToPoints(course.grade)));
  // How much the course list can be trusted as the transcript: eight or
  // more courses on file is a transcript, one is a start. The rigor and
  // major-preparation reads scale with it, and the coursework flags wait
  // for it, so a record with one course entered is not read as a light one.
  const courseEvidence = clamp01(courses.length / 8);
  const academicAwardsCount = activities.filter((a) => /(award|winner|finalist|olympiad|medal|honor|scholar)/i.test(`${a.name || ""} ${a.description || ""}`)).length;
  const ecImpactTier = avg(strengthRows.map((row) => {
    switch (row.tier_label) {
      case "tier_1_distinctive": return 5;
      case "tier_2_strong": return 4;
      case "tier_3_developing": return 3;
      case "tier_4_foundational": return 2;
      default: return 2;
    }
  })) || 2;
  const ecMajorAlignment = avg(strengthRows.map((row) => Number(row.major_spike || row.narrative_fit || 0) * 100)) || 0;
  // No narrative is no evidence, not weak evidence: null, and every reader
  // treats it as neutral. A flat 25 used to pull every school toward
  // "Reach" for a student who had not written one yet.
  const narrativeCoherence = narrative
    ? round1(clamp01(avg(strengthRows.map((row) => Number(row.narrative_fit || 0))) || 0.35) * 100)
    : null;

  return {
    gpa,
    weightedGpa,
    gpaBasis,
    sat,
    act,
    satSections,
    actSections,
    classRank,
    apExams,
    rankPercentile,
    courses,
    relevantCourses,
    courseEvidence,
    rigor,
    rigorUnits: rigor.units,
    rigorousCourseCount,
    seniorRigorCount,
    majorRelevantGpa,
    majorInterest,
    majorBucket,
    academicAwardsCount,
    ecImpactTier,
    ecMajorAlignment,
    narrativeCoherence,
    strengthRows,
    activities,
  };
}

// ─── The student's record against the Common Data Set ────────────────
// Each read compares one part of the profile with the section of the CDS
// that describes the enrolled class, and returns both a 0–100 score for
// the readiness blend and the facts behind it (bands, positions, shares)
// for the fit card and the counselor.

// ACT ↔ SAT concordance (the 2018 ACT/College Board table, composite to
// total), used when the student holds one test and the school reports
// bands for the other.
const ACT_TO_SAT = Object.freeze({
  36: 1590, 35: 1540, 34: 1500, 33: 1460, 32: 1430, 31: 1400, 30: 1370, 29: 1340, 28: 1310, 27: 1280,
  26: 1240, 25: 1210, 24: 1180, 23: 1140, 22: 1110, 21: 1080, 20: 1040, 19: 1010, 18: 970, 17: 930,
  16: 890, 15: 850, 14: 800, 13: 760, 12: 710, 11: 670, 10: 630, 9: 590,
});

export function actToSat(act) {
  const composite = Math.round(Number(act));
  if (!Number.isFinite(composite)) return null;
  return ACT_TO_SAT[Math.max(9, Math.min(36, composite))] ?? null;
}

export function satToAct(sat) {
  const total = Number(sat);
  if (!Number.isFinite(total)) return null;
  let best = null;
  for (const [composite, equivalent] of Object.entries(ACT_TO_SAT)) {
    const distance = Math.abs(equivalent - total);
    if (best == null || distance < best.distance) best = { composite: Number(composite), distance };
  }
  return best ? best.composite : null;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The standard normal's cumulative share below z (Zelen & Severo's
// approximation, within 1e-7), for reading a value against an average.
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

function bandOf(low, high) {
  const lo = numberOrNull(low);
  const hi = numberOrNull(high);
  return lo != null && hi != null && lo > 0 && hi >= lo ? { low: lo, high: hi } : null;
}

// Where a value sits against a middle-50% band, and the 0–100 score that
// position earns. At or above the 75th percentile is 92; inside the band
// runs 65–90; below the 25th drops off with the slope the scale deserves
// (a sub-range score reads as the liability it is).
function positionLabel(value, band) {
  if (value == null || !band) return "unknown";
  return value >= band.high ? "above" : value >= band.low ? "within" : "below";
}

function positionScore(value, band, slopePerPoint) {
  if (value == null || !band) return null;
  if (value >= band.high) return 92;
  if (value >= band.low) return 65 + ((value - band.low) / Math.max(1e-9, band.high - band.low)) * 25;
  return Math.max(12, 58 - (band.low - value) * slopePerPoint);
}

const SAT_SECTION_KEYS = [["readingWriting", "ebrw", "Reading & Writing"], ["math", "math", "Math"]];
const ACT_SECTION_KEYS = [["english", "english", "English"], ["math", "math", "Math"], ["reading", "reading", "Reading"], ["science", "science", "Science"]];

function sectionReads(sections, bands, keys, slope) {
  if (!sections || !bands) return [];
  const out = [];
  for (const [key, bandKey, label] of keys) {
    const value = numberOrNull(sections[key]);
    const band = bandOf(bands[bandKey]?.p25, bands[bandKey]?.p75);
    if (value == null || !band) continue;
    out.push({ key, label, value, band, position: positionLabel(value, band), score: round1(positionScore(value, band, slope)) });
  }
  return out;
}

// One test's read: composite against the band (or against the other
// test's band through concordance), sections against section bands, and
// the blend the readiness score uses (70% composite, 30% sections). The
// section part is half the mean and half the weakest section, so an 800
// in one section cannot hide a 700 in the other — a reader sees both.
function testCandidate({ test, score, band, convertedFrom = null, equivalent = null, sections = [] }) {
  const slope = test === "sat" ? 1 / 6 : 7;
  const composite = positionScore(equivalent ?? score, band, slope);
  const sectionMean = sections.length
    ? avg(sections.map((s) => s.score)) * 0.5 + Math.min(...sections.map((s) => s.score)) * 0.5
    : null;
  const blended = composite == null ? 50 : (sectionMean != null ? composite * 0.7 + sectionMean * 0.3 : composite);
  const position = positionLabel(equivalent ?? score, band);
  return {
    test,
    score,
    convertedFrom,
    equivalent,
    band,
    position,
    sections,
    weakSection: position !== "below" && sections.some((s) => s.position === "below"),
    compositeScore: composite != null ? round1(composite) : null,
    score0to100: round1(clamp01(blended / 100) * 100),
  };
}

// Where the student's total falls in the school's score-range table: the
// band, the share of enrolled submitters in it, and the share above it.
function distributionPlacement(rows, value) {
  if (!Array.isArray(rows) || !rows.length || value == null) return null;
  const sorted = [...rows].filter((r) => r && Number.isFinite(Number(r.low))).sort((a, b) => Number(b.low) - Number(a.low));
  let band = sorted.find((r) => value >= Number(r.low) && value <= Number(r.high));
  if (!band) band = value > Number(sorted[0].high) ? sorted[0] : sorted[sorted.length - 1];
  const shareAbove = sorted.filter((r) => Number(r.low) > Number(band.low)).reduce((sum, r) => sum + (Number(r.pct) || 0), 0);
  return {
    band: `${band.low}–${band.high}`,
    shareInBand: round1(Number(band.pct) || 0),
    shareAbove: round1(shareAbove),
    shareAtOrBelow: round1(Math.max(0, 100 - shareAbove)),
  };
}

// The two ways the read treats a test policy. Test-flexible (SAT, ACT, AP
// or IB, Yale's from 2024 until May 2026) still requires a score, so it
// reads as required; test-blind and test-free read as optional, where a
// score the student would withhold is not counted. CDS values
// ("test_required_some") and the read's own buckets map to themselves.
export function testPolicyBucket(value) {
  const v = String(value || "").toLowerCase();
  if (!v) return null;
  if (/flexible/.test(v)) return "test_considered_or_required";
  if (/optional|blind|deemphas|de-emphas|free/.test(v)) return "test_optional_or_deemphasized";
  if (/required|considered/.test(v)) return "test_considered_or_required";
  return null;
}

// The test policy a school states now, from the policy scout's reading of
// its own admissions pages: a recognized value with the sentence it was read
// from, checked within the last year. A Common Data Set describes the class
// that entered a year or two before, and the most selective schools changed
// course in between: Dartmouth has required scores again since the 2024-25
// cycle while the 2025-26 set in the store reads test-optional, so a student
// with no score was read as if none were needed.
const STATED_POLICY_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export function statedTestPolicy(snapshot, { now = Date.now() } = {}) {
  const tp = snapshot?.policy?.testPolicy;
  const bucket = testPolicyBucket(tp?.value);
  if (!bucket || !String(tp?.evidence || "").trim()) return null;
  const checked = Date.parse(snapshot?.checkedAt || "");
  if (!Number.isFinite(checked) || now - checked > STATED_POLICY_MAX_AGE_MS) return null;
  return {
    value: tp.value,
    bucket,
    through: tp.through || null,
    checkedAt: snapshot.checkedAt,
    sourceUrl: tp.sourceUrl || null,
    evidence: tp.evidence,
  };
}

export function compareTestsToSchool(student, college, cdsResult) {
  const parsed = cdsResult?.parsed || {};
  // What the school's own pages say this cycle, when the caller read it
  // (statedTestPolicy); `policy` is then its bucket.
  const stated = parsed.testPolicyStated || null;
  // A policy nobody read is "unknown", not "required". The read used to
  // default to required whenever no policy was held (every baseline-only
  // and Scorecard-only school, and the Common Data Sets whose C8A the parser
  // did not read, UCLA's among them), so a student with no score was scored
  // 18 instead of 42 and told tests were required at test-blind schools.
  const bucket = testPolicyBucket(parsed.testPolicy);
  const policy = bucket || "unknown";
  const optional = bucket === "test_optional_or_deemphasized";
  // Test-blind (and test-free) schools do not read a score at all, so one
  // on file carries no weight: it used to count as at a test-optional
  // school. The raw value is the school's own when it was stated.
  const rawPolicy = stated ? stated.value : (parsed.testPolicyValue ?? parsed.testPolicy);
  const blind = optional && /blind|free/i.test(String(rawPolicy || ""));
  const satBand = bandOf(college?.sat25 ?? college?.sat_25 ?? parsed.satComposite?.low, college?.sat75 ?? college?.sat_75 ?? parsed.satComposite?.high);
  const actBand = bandOf(college?.act25 ?? college?.act_25 ?? parsed.actComposite?.low, college?.act75 ?? college?.act_75 ?? parsed.actComposite?.high);
  const candidates = [];
  if (student.sat) {
    if (satBand || !actBand) {
      candidates.push(testCandidate({ test: "sat", score: student.sat, band: satBand, sections: sectionReads(student.satSections, parsed.satSections, SAT_SECTION_KEYS, 1 / 3) }));
    } else {
      candidates.push(testCandidate({ test: "sat", score: student.sat, band: actBand, convertedFrom: "sat", equivalent: satToAct(student.sat) }));
    }
  }
  if (student.act) {
    if (actBand || !satBand) {
      candidates.push(testCandidate({ test: "act", score: student.act, band: actBand, sections: sectionReads(student.actSections, parsed.actSections, ACT_SECTION_KEYS, 7) }));
    } else {
      candidates.push(testCandidate({ test: "act", score: student.act, band: satBand, convertedFrom: "act", equivalent: actToSat(student.act) }));
    }
  }
  // The student submits the stronger test; a native read beats a converted
  // one on a tie.
  const best = candidates.length
    ? [...candidates].sort((a, b) => (b.score0to100 - a.score0to100) || ((a.convertedFrom ? 1 : 0) - (b.convertedFrom ? 1 : 0)))[0]
    : null;
  // No scores on file is a genuine unknown, not a positive: modest even at
  // a test-optional school (42), low where tests are required (18), and
  // the optional 42 where the policy itself is unknown, since missing
  // evidence is neutral. A score the student would withhold at a
  // test-optional school (below the 25th percentile) counts no worse than
  // no score; at a test-blind school a score is not considered.
  const baseline = optional || !bucket ? 42 : 18;
  let advice = "none";
  let score = baseline;
  if (best && blind) {
    advice = "not_considered";
  } else if (best) {
    if (!optional) advice = "submit";
    else if (best.position === "below") advice = "withhold";
    else if (best.score0to100 < 72) advice = "borderline";
    else advice = "submit";
    score = advice === "withhold" ? Math.max(best.score0to100, baseline) : best.score0to100;
  }
  const distributionRows = best && !best.convertedFrom
    ? (best.test === "sat" ? parsed.scoreDistribution?.satComposite : parsed.scoreDistribution?.actComposite)
    : null;
  return {
    policy,
    blind,
    stated: stated ? { value: stated.value, through: stated.through ?? null, checkedAt: stated.checkedAt ?? null, sourceUrl: stated.sourceUrl ?? null } : null,
    advice,
    score: round1(score),
    best,
    candidates,
    distribution: distributionPlacement(distributionRows, best?.score),
    submitting: parsed.submitting && typeof parsed.submitting === "object" ? parsed.submitting : null,
  };
}

export function scoreTestPercentile(student, college, cdsResult) {
  return compareTestsToSchool(student, college, cdsResult).score;
}

// GPA against the admitted average (C12), the C11 band, and the C11
// distribution: the share of the enrolled class in the student's GPA band
// or above. With an average, the distribution refines the read (60/40);
// without one, the distribution or the band stands alone.
// What a school's admitted average GPA is likely to be when nothing reports
// it, from its admit rate: a 5%-admit school's class averages about 3.95,
// a 75%-admit one about 3.5. A flat 3.75 used to stand in for every unknown
// school, so a 75%-admit school with no parsed bands read as selective as
// a 40%-admit one and a 3.7 GPA there scored 46.
const AVERAGE_GPA_BY_ADMIT_RATE = [[0.05, 3.95], [0.2, 3.85], [0.4, 3.75], [0.6, 3.6], [0.8, 3.45], [0.95, 3.3]];
export function defaultAverageGpaFor(admitRate) {
  if (admitRate == null || !Number.isFinite(admitRate)) return 3.75;
  const points = AVERAGE_GPA_BY_ADMIT_RATE;
  if (admitRate <= points[0][0]) return points[0][1];
  if (admitRate >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 1; i < points.length; i += 1) {
    const [r0, g0] = points[i - 1];
    const [r1, g1] = points[i];
    if (admitRate <= r1) return round2(g0 + (g1 - g0) * ((admitRate - r0) / (r1 - r0)));
  }
  return 3.75;
}

export function compareGpaToSchool(student, college, cdsResult, { fallbackAverage = null } = {}) {
  const parsed = cdsResult?.parsed || {};
  const average = numberOrNull(college?.avgGpaAdmitted ?? college?.avg_gpa_admitted ?? parsed.gpaAverage);
  const band = bandOf(parsed.gpaBand?.low, parsed.gpaBand?.high);
  const rows = Array.isArray(parsed.gpaDistribution) && parsed.gpaDistribution.length ? parsed.gpaDistribution : null;
  const rawGpa = student.gpa;
  // An unweighted GPA above 4.0 is on a scale the profile does not record
  // (4.3, 5.0, or a weighted figure typed in the unweighted box). It is not
  // placed on the 4.0 scale, where a 4.52 read "above" every average; it
  // is compared only with a weighted average, and otherwise read as at the
  // average (the neutral point) with a note asking for the scale.
  const scaleUnknown = rawGpa != null && rawGpa > 4;
  const gpa = scaleUnknown ? null : rawGpa;
  // A weighted GPA with no unweighted one is compared on the 4.0 scale at
  // most at 4.0: it used to be dropped, scoring the same 30 as no GPA at
  // all, while the priorities matrix counted it as evidence (fit-4).
  const weightedOnly = rawGpa == null && student.weightedGpa != null;
  // An average above 4.0 is a weighted one (Harvard reports 4.21): it is
  // compared with the student's weighted GPA, or capped at 4.0 when the
  // student has none, never with the unweighted GPA it would dwarf.
  const weightedScale = average != null && average > 4;
  const gpaForAverage = weightedScale
    ? (student.weightedGpa ?? rawGpa)
    : (gpa ?? (weightedOnly ? Math.min(student.weightedGpa, 4) : null));
  // The share of an enrolled class at or below the student's GPA, taking
  // the class as spread 0.25 around its average, on the same 20–92 scale
  // the distribution read uses: at the average 56, 0.2 above 77, 0.2 below
  // 35. The window used to fall to zero 0.35 below the average, so a 3.7
  // against a 3.85 scored 31 and a thin record read "High reach" at a
  // 50%-admit school. No-GPA default 30. With no average on file the
  // caller's fallback (from the admit rate) stands in, else 3.75.
  const target = weightedScale && student.weightedGpa == null && !scaleUnknown ? 4 : (average ?? fallbackAverage ?? 3.75);
  const formulaScore = gpaForAverage != null
    ? 20 + 72 * normalCdf((gpaForAverage - target) / 0.25)
    : (scaleUnknown ? 56 : 30);
  let placement = null;
  let distributionScore = null;
  if (gpa != null && rows) {
    const sorted = [...rows].sort((a, b) => Number(b.low) - Number(a.low));
    let studentBand = sorted.find((r) => gpa >= Number(r.low) && gpa <= Number(r.high) + 0.005);
    if (!studentBand) studentBand = gpa > Number(sorted[0].high) ? sorted[0] : sorted[sorted.length - 1];
    const shareAbove = sorted.filter((r) => Number(r.low) > Number(studentBand.low)).reduce((sum, r) => sum + (Number(r.pct) || 0), 0);
    placement = {
      band: Number(studentBand.low) === Number(studentBand.high) ? String(studentBand.low) : `${studentBand.low}–${studentBand.high}`,
      shareInBand: round1(Number(studentBand.pct) || 0),
      shareAbove: round1(shareAbove),
      shareAtOrBelow: round1(Math.max(0, 100 - shareAbove)),
    };
    distributionScore = 20 + 72 * (placement.shareAtOrBelow / 100);
  }
  const bandScore = gpa != null && band ? positionScore(gpa, band, 60) : null;
  let score;
  let basis;
  if (scaleUnknown) { score = formulaScore; basis = "scale_unknown"; }
  else if (weightedOnly) { score = formulaScore; basis = "weighted_only"; }
  else if (gpa == null) { score = formulaScore; basis = "none"; }
  else if (average != null && distributionScore != null) { score = formulaScore * 0.6 + distributionScore * 0.4; basis = "average+distribution"; }
  else if (average != null) { score = formulaScore; basis = "average"; }
  else if (distributionScore != null) { score = bandScore != null ? distributionScore * 0.5 + bandScore * 0.5 : distributionScore; basis = "distribution"; }
  else if (bandScore != null) { score = bandScore; basis = "band"; }
  else { score = formulaScore; basis = "default"; }
  const againstTarget = () => (gpaForAverage >= target + 0.05 ? "above" : gpaForAverage >= target - 0.1 ? "within" : "below");
  let position;
  if (scaleUnknown) position = weightedScale && gpaForAverage != null ? againstTarget() : "unknown";
  else if (weightedOnly) position = (average != null || weightedScale) && gpaForAverage != null ? againstTarget() : "unknown";
  else if (gpa == null) position = "unknown";
  else position = band ? positionLabel(gpa, band) : (average != null && gpaForAverage != null ? againstTarget() : "unknown");
  return {
    gpa: rawGpa,
    weightedGpa: student.weightedGpa ?? null,
    average,
    averageScale: average == null ? null : (weightedScale ? "weighted" : "unweighted"),
    comparedGpa: gpaForAverage,
    band,
    position,
    placement,
    basis,
    // The card asks for the scale when an unweighted GPA above 4.0 was
    // read; nothing else is noted.
    note: scaleUnknown ? "gpa_scale_unknown" : null,
    score: round1(clamp01(score / 100) * 100),
  };
}

// Class rank against C10: the share of the enrolled class that stood
// above the student's bucket (top tenth, quarter, half). A top-tenth
// student has nobody above; a top-quarter student at a school where 94%
// were top tenth sits below almost all of them.
export function compareRankToSchool(student, cdsResult) {
  const shares = cdsResult?.parsed?.classRank && typeof cdsResult.parsed.classRank === "object" ? cdsResult.parsed.classRank : null;
  const topPercent = student.classRank?.topPercent ?? (student.rankPercentile != null ? round1(100 - student.rankPercentile) : null);
  const school = shares
    ? { topTenthPct: numberOrNull(shares.topTenthPct), topQuarterPct: numberOrNull(shares.topQuarterPct), topHalfPct: numberOrNull(shares.topHalfPct), submittedPct: numberOrNull(shares.submittedPct) }
    : null;
  if (topPercent == null) return { topPercent: null, bucket: null, school, shareAbove: null, basis: "unknown", score: 50 };
  const bucket = topPercent <= 10 ? "top10" : topPercent <= 25 ? "top25" : topPercent <= 50 ? "top50" : "bottom50";
  let shareAbove = null;
  if (school?.topTenthPct != null) {
    shareAbove = bucket === "top10" ? 0
      : bucket === "top25" ? school.topTenthPct
      : bucket === "top50" ? (school.topQuarterPct ?? school.topTenthPct)
      : (school.topHalfPct ?? school.topQuarterPct ?? school.topTenthPct);
  }
  const score = shareAbove != null ? 20 + 72 * ((100 - shareAbove) / 100) : clamp01((100 - topPercent) / 100) * 100;
  return { topPercent, bucket, school, shareAbove: shareAbove != null ? round1(shareAbove) : null, basis: shareAbove != null ? "cds_c10" : "percentile", score: round1(score) };
}

// AP exam results: the average maps 1→20, 3→57.5, 4→76, 5→95; exams in the
// intended field weigh 60/40 against the rest, and three or more 4s and 5s
// add a little. No exams yet is no evidence, and the component drops out.
export function compareApExams(student) {
  const ap = student.apExams || { count: 0 };
  if (!ap.count) return { ...ap, score: null };
  const mapped = (value) => 20 + (value - 1) * 18.75;
  const overall = mapped(ap.average);
  let score = ap.relevantAverage != null ? mapped(ap.relevantAverage) * 0.6 + overall * 0.4 : overall;
  if (ap.strong >= 3) score += 5;
  return { ...ap, score: round1(Math.min(100, score)) };
}

// Course rigor against the load the school's admitted average implies. The
// expectation follows that average on the 4.0 scale (a 3.9 average asks
// for about seven college-level courses; a weighted 4.21 would otherwise
// demand ten AP courses), never fewer than four. The load is the weighted
// read from course-rigor.js — AP, IB, dual-enrollment and A-Level courses
// by type or name, AP exams no course names, each AP lifted or lowered by
// its exam score, honors at half a unit, half a unit more per senior-year
// college-level course — the one `units` figure the matrix shows too.
// Meeting the expectation reads "above" (the load is there), sixty percent
// of it "within", less "below".
export function compareCourseRigor(student, averageGpa = null) {
  const rigor = student?.rigor || readCourseRigor(student?.courses || [], []);
  const targetGpa = Math.min(4, averageGpa ?? 3.75);
  const expectation = Math.max(4, Math.round((targetGpa - 3.2) * 10));
  // `units` already carries the senior-year credit (course-rigor.js), so
  // the matrix's detail and this read show the same number.
  const units = Number(student?.rigorUnits ?? rigor.units ?? 0);
  const ratio = units / Math.max(1, expectation);
  const position = ratio >= 1 ? "above" : ratio >= 0.6 ? "within" : "below";
  return {
    apTaken: rigor.apTaken,
    apCourses: rigor.apCourses,
    apExamsWithoutCourse: rigor.apExamsWithoutCourse,
    apScored: rigor.apScored,
    ib: rigor.ib,
    dualEnrollment: rigor.dualEnrollment,
    aLevel: rigor.aLevel,
    honors: rigor.honors,
    units: round1(units),
    expectation,
    position,
    score: round1(clamp01(ratio) * 100),
  };
}

export function scoreAcademicReadiness(student, college, cdsResult) {
  const c7 = cdsResult?.parsed?.c7 || {};
  const tests = compareTestsToSchool(student, college, cdsResult);
  // A school whose averages are not on file is judged against what its
  // admit rate implies, not against a selective school's numbers.
  const admitRateForDefaults = normalizePercentValue(college?.acceptanceRate ?? college?.acceptance ?? college?.admission_rate ?? (cdsResult?.parsed?.admitRatePercent != null ? cdsResult.parsed.admitRatePercent : null));
  const fallbackAverage = defaultAverageGpaFor(admitRateForDefaults != null && admitRateForDefaults > 0 ? admitRateForDefaults : null);
  const gpaRead = compareGpaToSchool(student, college, cdsResult, { fallbackAverage });
  const rankRead = compareRankToSchool(student, cdsResult);
  const apRead = compareApExams(student);
  const rigorRead = compareCourseRigor(student, gpaRead.average ?? fallbackAverage);
  // The course list's weight follows how complete it looks (courseEvidence):
  // rigor read from one entered course is hardly evidence of a light load.
  const courseEvidence = student.courseEvidence ?? 1;
  // With no intended major there is no major to be prepared for: the
  // component drops out, as AP exams and class rank do when absent.
  const hasMajor = Boolean(student.majorBucket);
  const featureWeights = {
    gpa: 0.27 + 0.08 * c7Value(c7, ["academicGpa", "academic_gpa", "gpa"], 0.7),
    rigor: (0.2 + 0.08 * c7Value(c7, ["rigor"], 0.7)) * courseEvidence,
    majorPrep: hasMajor ? 0.18 * (0.5 + 0.5 * courseEvidence) : 0,
    // A score the student would withhold at a test-optional school is
    // never read, and a test-blind school reads none, so the other
    // evidence carries its weight.
    test: tests.advice === "withhold" || tests.blind ? 0 : 0.14 + 0.08 * c7Value(c7, ["standardizedTests", "standardized_tests", "test_scores"], 0.35),
    // AP exam results count once the student has any; before the first
    // exam the component is absent rather than a penalty. The same for
    // academic awards and class rank since 2026-09-22: no award used to
    // score 25 and no rank 50, and a constant "trend" of 60 carried 7% of
    // the weight, so every student was pulled toward the middle and a
    // 3.95 / 1520 record with six APs scored 75 (the calibration read
    // "Reach" at a 75%-admit school). What is not on file drops out.
    apExams: apRead.score != null ? 0.06 : 0,
    awards: student.academicAwardsCount > 0 ? 0.08 : 0,
    trend: 0,
    rank: rankRead.basis === "unknown" ? 0 : 0.06 + 0.03 * c7Value(c7, ["classRank", "class_rank"], 0.35),
  };
  const totalWeight = Object.values(featureWeights).reduce((a, b) => a + b, 0);
  for (const key of Object.keys(featureWeights)) featureWeights[key] /= totalWeight;

  const gpaScore = gpaRead.score;
  const rigorScore = rigorRead.score;
  // A GPA whose scale is unknown (above 4.0) is not read as a 4.0-scale one here either.
  const fourScaleGpa = student.gpa != null && student.gpa <= 4 ? student.gpa : null;
  const majorPrepScore = clamp01(((student.relevantCourses.length / 5) * 0.55) + (((student.majorRelevantGpa ?? fourScaleGpa ?? 3.2) / 4) * 0.45)) * 100;
  const testScore = tests.score;
  const apExamScore = apRead.score ?? 0;
  const awardsScore = Math.min(100, student.academicAwardsCount * 18 + 40);
  const trendScore = 60; // reported for the breakdown's shape; weight 0
  const rankScore = rankRead.score;

  const componentScores = { gpaScore, rigorScore, majorPrepScore, testScore, apExamScore, awardsScore, trendScore, rankScore };
  const score =
    gpaScore * featureWeights.gpa +
    rigorScore * featureWeights.rigor +
    majorPrepScore * featureWeights.majorPrep +
    testScore * featureWeights.test +
    apExamScore * featureWeights.apExams +
    awardsScore * featureWeights.awards +
    trendScore * featureWeights.trend +
    rankScore * featureWeights.rank;

  // ─── C7 transparency breakdown ────────────────────────────────────
  // Surfaces, for each C7 factor used, its rating label, the numeric
  // weight (1.0 / 0.7 / 0.35 / 0.0), and the resulting modulation on
  // the dynamic weight. Lets the AI assistant explain "why Princeton's
  // academic readiness scored higher than Stanford's for the same student".
  const c7Breakdown = [
    { factor: "academic_gpa",       rating: c7?.academicGpa ?? c7?.academic_gpa ?? c7?.gpa ?? null, numericWeight: c7Value(c7, ["academicGpa","academic_gpa","gpa"], 0.7), affectsDynamicWeight: "gpa" },
    { factor: "rigor",              rating: c7?.rigor ?? null, numericWeight: c7Value(c7, ["rigor"], 0.7), affectsDynamicWeight: "rigor" },
    { factor: "standardized_tests", rating: c7?.standardizedTests ?? c7?.standardized_tests ?? c7?.test_scores ?? null, numericWeight: c7Value(c7, ["standardizedTests","standardized_tests","test_scores"], 0.35), affectsDynamicWeight: "test" },
    { factor: "class_rank",         rating: c7?.classRank ?? c7?.class_rank ?? null, numericWeight: c7Value(c7, ["classRank","class_rank"], 0.35), affectsDynamicWeight: "rank" },
  ];

  return {
    score: round1(score),
    componentScores,
    dynamicWeights: Object.fromEntries(Object.entries(featureWeights).map(([k, v]) => [k, round2(v)])),
    c7Breakdown,
    // The facts behind the blend, for the fit card and the counselor.
    reads: { tests, gpa: gpaRead, classRank: rankRead, apExams: apRead, rigor: rigorRead },
  };
}

export function scoreMajorCompetitiveness(student, collegeContext, options = {}) {
  // No intended major reads the neutral pool: average demand, no IPEDS
  // growth signal, middling saturation. It used to be the computer-science
  // pool, the most crowded one.
  const bucket = student.majorBucket || null;
  const baseDemand = (bucket && MAJOR_DEMAND_BASE[bucket]) ?? 0.6;
  const ipedsGrowth = bucket ? (options.ipedsGrowthByBucket?.[bucket] ?? IPEDS_CIP_GROWTH_PROXY[bucket] ?? null) : null;
  const schoolSpecificSaturation = (() => {
    if (!bucket) return 0.5;
    const majors = (collegeContext.topMajors || []).map((m) => String(m).toLowerCase());
    if (majors.length === 0) return 0.5;
    return majors.some((m) => m.includes(bucket.replace(/_/g, " "))) ? 0.7 : 0.45;
  })();
  const majorPolicy = options.majorPolicy || null;
  const policyPenalty =
    majorPolicy?.policyType === "capped" ? 0.16 :
    majorPolicy?.policyType === "direct_admit" ? 0.18 :
    majorPolicy?.policyType === "restricted" ? 0.14 : 0;
  const internalTransferPenalty = majorPolicy?.internalTransferDifficulty === "high" ? 0.08 : majorPolicy?.internalTransferDifficulty === "medium" ? 0.04 : 0;
  const capacityOffset = clamp01(Number(majorPolicy?.capacityExpansionOffset ?? 0));

  const difficultyIndex = clamp01((baseDemand * 0.38) + ((ipedsGrowth ?? 0.55) * 0.22) + (schoolSpecificSaturation * 0.22) + policyPenalty + internalTransferPenalty - (capacityOffset * 0.14));
  const competitivenessScore = round1((1 - difficultyIndex) * 100);
  const capacityRiskFlag =
    majorPolicy?.policyType ? `${majorPolicy.policyType}:${majorPolicy.evidenceStrength || "stated"}` :
    difficultyIndex >= 0.72 ? "elevated" :
    difficultyIndex >= 0.58 ? "moderate" : "normal";

  return {
    score: competitivenessScore,
    difficultyIndex: round2(difficultyIndex),
    baseDemand: round2(baseDemand),
    ipedsGrowthProxy: ipedsGrowth != null ? round2(ipedsGrowth) : null,
    schoolSpecificSaturation: round2(schoolSpecificSaturation),
    policyPenalty: round2(policyPenalty + internalTransferPenalty),
    capacityOffset: round2(capacityOffset),
    capacityRiskFlag,
  };
}

export function scoreInstitutionalPriorityFit(student, cdsResult) {
  const c7 = cdsResult?.parsed?.c7 || {};
  const essayWeight = c7Value(c7, ["essay", "application_essay"], 0.35);
  const ecWeight = c7Value(c7, ["extracurriculars", "ec"], 0.35);
  const characterWeight = c7Value(c7, ["character"], 0.35);
  const recWeight = c7Value(c7, ["recommendation", "recommendations"], 0.35);

  // Missing evidence is neutral (50), not weak: a student with no strength
  // rows yet, or no narrative, used to score about 18 here, and that number
  // then counted against every school.
  const hasEcEvidence = student.strengthRows.length > 0;
  const ecStrength = hasEcEvidence ? clamp01((student.ecImpactTier - 1) / 4) * 100 : 50;
  const majorAlignment = hasEcEvidence ? clamp01(student.ecMajorAlignment / 100) * 100 : 50;
  const narrative = clamp01((student.narrativeCoherence ?? 50) / 100) * 100;
  const recProxy = clamp01((narrative * 0.6 + majorAlignment * 0.4) / 100) * 100;

  const raw =
    ecStrength * (0.32 + ecWeight * 0.18) +
    majorAlignment * 0.24 +
    narrative * (0.22 + essayWeight * 0.14 + characterWeight * 0.08) +
    recProxy * (0.08 + recWeight * 0.08);
  const normalized = raw / (0.32 + ecWeight * 0.18 + 0.24 + 0.22 + essayWeight * 0.14 + characterWeight * 0.08 + 0.08 + recWeight * 0.08);

  return {
    score: round1(normalized),
    c7SignalsUsed: {
      essay: round2(essayWeight),
      extracurriculars: round2(ecWeight),
      character: round2(characterWeight),
      recommendation: round2(recWeight),
    },
  };
}

export function scoreStrategicFocusBonus(strategicSignals = [], majorPolicy = null) {
  if (!Array.isArray(strategicSignals) || strategicSignals.length === 0) {
    return { bonus: 0, evidenceCount: 0, averageStrength: 0 };
  }
  const avgStrength = avg(strategicSignals.map((signal) => ((Number(signal.evidenceStrength || 0) * 0.65) + (Number(signal.recencyScore || 0) * 0.35)) * 100)) || 0;
  const policyOffset = majorPolicy?.capacityExpansionOffset ? Number(majorPolicy.capacityExpansionOffset) * 6 : 0;
  const bonus = round1(Math.min(12, (avgStrength / 100) * 10 + policyOffset));
  return {
    bonus,
    evidenceCount: strategicSignals.length,
    averageStrength: round1(avgStrength),
  };
}

export function scoreNarrativeFit(student) {
  // Neutral where there is nothing to read: no narrative, no strength rows.
  const coherence = round1(student.narrativeCoherence ?? 50);
  const alignment = student.strengthRows.length ? student.ecMajorAlignment : 50;
  // Major coursework is half-credited (neutral) when there is no major to
  // have coursework for.
  const courseShare = student.majorBucket ? clamp01((student.relevantCourses.length || 0) / 5) : 0.5;
  const specificity = round1((alignment * 0.55) + (courseShare * 45));
  const authenticity = round1(Math.min(100, 40 + student.strengthRows.length * 8));
  const score = round1((coherence * 0.5) + (specificity * 0.35) + (authenticity * 0.15));
  return { score, coherence, specificity, authenticity };
}

export function scoreDifferentiationStrength(student) {
  const spike = avg(student.strengthRows.map((row) => Number(row.major_spike || 0))) || 0;
  const prestige = avg(student.strengthRows.map((row) => Number(row.prestige || 0))) || 0;
  const leadership = avg(student.strengthRows.map((row) => Number(row.leadership || 0))) || 0;
  const achievement = avg(student.strengthRows.map((row) => Number(row.achievement || 0))) || 0;
  const score = round1(clamp01(spike * 0.4 + prestige * 0.18 + leadership * 0.16 + achievement * 0.16 + (student.ecImpactTier / 5) * 0.1) * 100);
  return {
    score,
    majorSpike: round1(spike * 100),
    prestige: round1(prestige * 100),
    leadership: round1(leadership * 100),
    achievement: round1(achievement * 100),
  };
}

export function scoreInstitutionalSelectivityAdjustment(collegeContext) {
  const admitRate = normalizePercentValue(collegeContext.acceptanceRate ?? collegeContext.acceptance ?? collegeContext.admission_rate ?? null);
  if (admitRate == null || admitRate <= 0) return { adjustment: 1, selectivityIndex: null };
  const selectivityIndex = clamp01(1 - admitRate);
  // DEVALUATION, inversely proportional to the acceptance rate. The devaluation
  // tracks the ODDS AGAINST admission, (1 − rate)/rate ≈ 1/rate for small rate,
  // so it concentrates almost entirely on ultra-selective schools and fades to
  // ~nothing for high-admit ones — unlike the old linear `1 − (1 − rate)·0.15`
  // dampener, which barely separated a 4%-admit Ivy from a 60%-admit state
  // school. Scaled by 0.02 and capped at 0.35 so a hyper-reach is discounted
  // hard (≈−35% at 4% admit, ≈−11% at 15%, ≈−2% at 50%, ~0 at high admit)
  // without collapsing to noise. UNKNOWN admit rate ⇒ no change (1.0), never a
  // boost. Applied ONCE, to the whole composite in buildPositioningForTarget
  // (not the academic sub-score), so selectivity is not double-counted.
  const oddsAgainst = (1 - admitRate) / admitRate;
  const devaluation = Math.min(0.35, 0.02 * oddsAgainst);
  const adjustment = round2(1 - devaluation);
  return { adjustment, selectivityIndex: round2(selectivityIndex) };
}

// How current a record is, by how many cycles it trails the newest one most
// schools have published (cds-cycle.js): the newest 0.9, one behind 0.85,
// older or undated 0.68. The rule used to be fixed years (2025 on read 0.9),
// so a 2025-26 document would have read as current forever and, before
// that, a 2025-26 document scored as stale as a 2019 one.
export function recencyScore(cycleLabel, now = new Date()) {
  const age = cycleAge(cycleLabel, now);
  if (age == null) return 0.68;
  return age === 0 ? 0.9 : age === 1 ? 0.85 : 0.68;
}

export function scoreEvidenceConfidence({ cdsResult, collegeContext, majorPolicy, ipedsGrowthAvailable, studentEvidencePenalty = 0, now = new Date() }) {
  const sourceQuality = cdsResult?.sourceUrl ? 0.78 : 0.5;
  const directness = cdsResult?.fetchStatus === "ok" ? 0.82 : cdsResult?.fetchStatus === "listed_without_direct_link" ? 0.35 : 0.2;
  // The cycle the record reports ("2025-26", "2024", "2023-24").
  const recency = recencyScore(cdsResult?.repositoryMatch?.latestAvailableYear, now);
  const consistency = collegeContext?.avgGpaAdmitted || collegeContext?.sat25 ? 0.76 : 0.5;
  const missingDataPenalty = [
    cdsResult?.parsed?.c7 ? 0 : 0.08,
    cdsResult?.parsed?.admitRatePercent != null || collegeContext?.acceptanceRate != null ? 0 : 0.08,
    ipedsGrowthAvailable ? 0 : 0.08,
    majorPolicy ? 0 : 0.06,
  ].reduce((a, b) => a + b, 0);
  const marketingLanguagePenalty = 0;
  // Live-parsed CDS that hasn't been checked against ground truth is real
  // data but unverified — a positional PDF parse can mis-read a number. Dock
  // confidence and cap it below "High" so an unvalidated record can never
  // present as authoritative as a curated/validated one.
  // A consistency-checked record (the school's own current document, its
  // numbers agreeing with each other, no same-cycle truth) is docked less
  // than an unverified parse, and still never reads "High".
  const isConsistent = cdsResult?.validated === false && cdsResult?.verification === "consistent";
  const isUnvalidated = cdsResult?.validated === false && !isConsistent;
  const unvalidatedPenalty = isUnvalidated ? 0.12 : isConsistent ? 0.05 : 0;
  // The student's side can lower it too: a GPA on an unknown scale is read
  // as at the average, a guess the bands should show.
  const raw = sourceQuality * 0.28 + recency * 0.18 + directness * 0.22 + consistency * 0.2 - missingDataPenalty - marketingLanguagePenalty - unvalidatedPenalty - (Number(studentEvidencePenalty) || 0);
  let normalized = clamp01(raw);
  if (isUnvalidated) normalized = Math.min(normalized, 0.74); // never "High" while unverified
  if (isConsistent) normalized = Math.min(normalized, 0.77);
  const label = normalized >= 0.78 ? "High" : normalized >= 0.58 ? "Medium" : normalized >= 0.35 ? "Low" : "Very Low";
  return {
    score: round1(normalized * 100), label, normalized: round2(normalized),
    validated: !isUnvalidated && !isConsistent,
    verification: isConsistent ? "consistent" : (isUnvalidated ? "unverified" : "validated"),
  };
}

const QUANTITATIVE_BUCKETS = new Set(["computer_science", "data_science", "computational_biology", "biomedical_engineering", "engineering", "mathematics", "physics", "chemistry", "economics"]);

// Each flag carries a stable code and its numbers beside the English
// sentence the chat quotes, so the card can say it in the student's
// language (a Korean-mode card printed every flag in English, fit-10).
export function buildRedFlagEntries(student, collegeContext, majorCompetitiveness, narrativeFit, reads = null) {
  const entries = [];
  const flags = { push: (text, code, params = null) => entries.push(params ? { code, params, text } : { code, text }) };
  // A math section under the school's 25th percentile is the number a
  // quantitative department reads first, whatever the total says.
  // A test-blind school reads no score, so no section of one is a flag there.
  const best = reads?.tests?.best;
  if (best && !reads?.tests?.blind && QUANTITATIVE_BUCKETS.has(student.majorBucket)) {
    const mathSection = (best.sections || []).find((s) => s.key === "math");
    if (mathSection?.position === "below") {
      flags.push(`${best.test.toUpperCase()} Math (${mathSection.value}) sits below this school's 25th percentile (${mathSection.band.low}), which a quantitative major will notice.`,
        "math_below_band", { test: best.test.toUpperCase(), value: mathSection.value, low: mathSection.band.low });
    }
  }
  // A school whose own admissions pages require scores this cycle, with no
  // SAT or ACT on file: the application is not complete without one. Under
  // a test-flexible policy AP results on file meet the requirement.
  const stated = reads?.tests?.stated;
  if (stated && !best) {
    const checked = String(stated.checkedAt || "").slice(0, 10);
    if (stated.value === "test_required") {
      flags.push(`This school's admissions site (checked ${checked}) says SAT or ACT scores are required this cycle, and no score is on file.`, "stated_test_required", { checked });
    } else if (stated.value === "test_flexible" && !(student.apExams?.count > 0)) {
      flags.push(`This school's admissions site (checked ${checked}) requires test scores this cycle (SAT, ACT, or AP or IB results under its test-flexible policy), and none is on file.`, "stated_test_flexible", { checked });
    }
  }
  if (reads?.apExams?.relevant?.length && reads.apExams.relevantAverage != null && reads.apExams.relevantAverage < 3) {
    flags.push("AP exam scores in the intended field average below 3.", "ap_field_below_3");
  }
  // The coursework flags wait for a course list that looks like a
  // transcript (four courses or more); one course entered says nothing
  // about what the student took.
  const transcriptOnFile = student.courses.length >= 4;
  if (transcriptOnFile && student.relevantCourses.length <= 1 && ["computer_science", "engineering", "computational_biology", "data_science", "business"].includes(student.majorBucket)) {
    flags.push("Weak major-relevant coursework for an ambitious intended major.", "weak_major_coursework");
  }
  if (student.activities.length >= 8 && student.strengthRows.length > 0 && (avg(student.strengthRows.map((row) => Number(row.dedication || 0))) || 0) < 0.35) {
    flags.push("Many shallow extracurriculars without enough sustained depth.", "shallow_activities");
  }
  // A narrative that reads weakly is a flag; a narrative not written yet is
  // not (the advice elsewhere asks for one).
  const hasNarrative = student.narrativeCoherence != null;
  if (hasNarrative && (student.majorInterest || "").match(/\b(ai|medicine|business)\b/i) && narrativeFit.specificity < 45) {
    flags.push("Narrative risks sounding generic for a crowded major lane.", "generic_narrative");
  }
  if (hasNarrative && narrativeFit.coherence < 45) {
    flags.push("Narrative coherence is weak and may read as a list rather than a story.", "weak_narrative_coherence");
  }
  // Preparation for a capped major needs a major: with none, the
  // neutral pool can still read "moderate", and the flag used to fire for
  // every student who had not chosen one (fit-1).
  if (transcriptOnFile && student.majorBucket && majorCompetitiveness.capacityRiskFlag !== "normal" && student.relevantCourses.length <= 2) {
    flags.push("Applying to a capped or capacity-constrained major without enough preparation.", "capped_major_unprepared");
  }
  if ((collegeContext.acceptanceRate ?? 100) < 15 && student.gpa != null && (collegeContext.avgGpaAdmitted ?? 3.9) - student.gpa > 0.2) {
    flags.push("Transcript looks light relative to this university's admitted academic range.", "light_transcript");
  }
  return entries;
}

// The English sentences alone, as the chat and older callers read them.
export function buildRedFlags(student, collegeContext, majorCompetitiveness, narrativeFit, reads = null) {
  return buildRedFlagEntries(student, collegeContext, majorCompetitiveness, narrativeFit, reads).map((entry) => entry.text);
}

// The label is an admission likelihood, not the composite. The school's
// admit rate is the base rate — what an applicant has before anything is
// known about them — and the composite (readiness) shifts the log-odds:
// each ten points above or below 60, about what a student at the school's
// own averages comes to, moves the odds by e^0.7 (twice), capped at ±2.4.
// So a 75%-admit school reads "Highly competitive" for a student in its
// range and "Competitive" or "Reach" for a thin record, a 4%-admit school
// reads "High reach" for almost everyone and "Reach" for the strongest,
// and an unknown admit rate is taken as 50%, never as the most selective,
// and the read says so (admitRate.assumedForLikelihood). A record with no
// GPA and no SAT/ACT at all gets no label (INSUFFICIENT_STUDENT_DATA).
// Until 2026-09-22 the composite alone was labelled, with cutoffs of
// 85/70/52 (raised from 82/67/48 when the labels read too optimistically
// at selective schools), and the admit rate could only lower it, so no
// school could read better than "Reach" for a student whose evidence was
// thin, however open its admission: a 3.95 / 1520 profile with six APs
// read "Reach" at a 75%-admit school.
//
// How far strong academics can lift the odds depends on the school (since
// 2026-10-09). At the most selective colleges nearly every applicant is
// academically qualified and the decision turns on what the record cannot
// show (essays, recommendations, recruited athletes, legacies): in Harvard's
// admissions data from the SFFA litigation (2014-2019), applicants in the top
// academic decile were admitted at about 13-15% against roughly 5% overall,
// odds about three times the base, a log-odds lift near 1.1. Chetty, Deming
// and Friedman (2023) found non-academic factors drive much of selection at
// Ivy-Plus colleges. Counselors accordingly treat schools admitting under
// about 10-15% as reaches for everyone. At a school admitting half its
// applicants, a record well above its averages is very likely admitted.
// So the upward lift is capped at 1.1 for a 5%-admit school, rising
// linearly to the former 2.4 at 45% and above; a 4%-admit school reads "High
// reach" even for the strongest record and an 8%-admit one "Reach". A weak
// record still loses up to 2.4 everywhere: falling below a school's range
// hurts at every level of selectivity.
export function maxReadinessLift(admitRate) {
  const base = admitRate == null ? 0.5 : admitRate;
  return Math.round((1.1 + 1.3 * Math.max(0, Math.min(1, (base - 0.05) / 0.40))) * 1e4) / 1e4;
}

export function admissionLikelihood({ readiness, admitRate }) {
  const base = Math.min(0.98, Math.max(0.02, admitRate == null ? 0.5 : admitRate));
  const bounded = Math.max(0, Math.min(100, Number(readiness) || 0));
  const shift = Math.max(-2.4, Math.min(maxReadinessLift(admitRate), (bounded - 60) * 0.07));
  const logit = Math.log(base / (1 - base)) + shift;
  return 1 / (1 + Math.exp(-logit));
}

// The admit rate outside Early Decision, from a Common Data Set's own
// counts. A school's headline rate counts its Early Decision admits, and ED
// pools are admitted at two to three times the regular rate (Avery,
// Fairbanks and Zeckhauser put the early boost near 100 SAT points; ED
// pools also carry recruited athletes and legacies), so for a student
// applying in the regular round the headline overstates the odds:
// Columbia's 2024-25 set admitted 3.9% overall, 13.2% of its 6,007 ED
// applicants, and 2.8% of everyone else. Returns fractions, or null when
// the counts are missing, inconsistent with the record's admit rate (a
// registry correction can replace the rate but not the counts), or would
// make the regular pool look easier than the whole. EA counts are not in
// the CDS, so the regular pool still includes Early Action.
export function admitRatePools(record) {
  const applied = Number(record?.b1?.applied);
  const admitted = Number(record?.b1?.admitted);
  const edApplied = Number(record?.extras?.earlyDecision?.applications);
  const edAdmitted = Number(record?.extras?.earlyDecision?.admitted);
  if (![applied, admitted, edApplied, edAdmitted].every((n) => Number.isFinite(n) && n > 0)) return null;
  if (edApplied >= applied || edAdmitted >= admitted || edAdmitted > edApplied) return null;
  const overall = admitted / applied;
  if (record?.overallAdmitRate != null && Math.abs(overall - Number(record.overallAdmitRate)) > 0.01) return null;
  const regular = (admitted - edAdmitted) / (applied - edApplied);
  if (!(regular > 0 && regular < overall)) return null;
  return {
    overall: Math.round(overall * 10000) / 10000,
    regular: Math.round(regular * 10000) / 10000,
    earlyDecision: Math.round((edAdmitted / edApplied) * 10000) / 10000,
  };
}

// Bumped whenever the read changes, so cached College Fit results (kept
// seven days, keyed by student and snapshot) are recomputed: "positioning_v2"
// is the selectivity-aware lift and the regular-pool base rate (2026-10-09);
// "positioning_v3" (2026-11-03) withholds the label from a record with no
// GPA and no SAT/ACT, reads no major as no major rather than computer
// science, takes the best SAT/ACT sitting, compares a weighted-only GPA and
// leaves an above-4.0 one unplaced, reads an unread test policy as unknown
// and a test-blind one as reading no score, and ages evidence by the clock.
// The same version carries the stable codes the card translates (labelKey,
// summaryKey, strategyKey, mainRedFlagCodes, evidenceConfidenceKey,
// dataNoteKeys): v3 had not shipped when they were added, so every cached
// payload in production predates both and is recomputed once.
export const POSITIONING_MODEL_VERSION = "positioning_v3";

export function classifyPositioningLabel(likelihoodScore) {
  if (likelihoodScore >= 70) return "Highly competitive";
  if (likelihoodScore >= 40) return "Competitive";
  if (likelihoodScore >= 15) return "Reach";
  return "High reach";
}

// A stable key beside each label for the card's translations; the label
// itself stays the English text the chat quotes.
const LABEL_KEYS = Object.freeze({
  "Highly competitive": "highly_competitive",
  Competitive: "competitive",
  Reach: "reach",
  "High reach": "high_reach",
});
export function positioningLabelKey(label) {
  return LABEL_KEYS[label] || null;
}

// The read withheld from a record that holds no academic evidence: no GPA
// of either kind and no SAT or ACT. A grade-9 student with nothing entered
// used to read "Reach" at a 70%-admit school and "High reach" where nothing
// was known, with "academically stretched" beside it, and the chat was told
// to use that exact label. The component reads stay for the comparison
// block; there is no likelihood and no label (fit-4).
export const INSUFFICIENT_STUDENT_DATA = Object.freeze({
  labelKey: "insufficient_student_data",
  label: "Not enough data yet",
});

export function studentDataNeeded(student) {
  const needed = [];
  if (student?.gpa == null && student?.weightedGpa == null) needed.push("gpa");
  if (!student?.sat && !student?.act) needed.push("sat_or_act");
  return needed;
}

export function hasEnoughStudentData(student) {
  return studentDataNeeded(student).length < 2;
}

// The strategy's stable key beside its English sentence (recommendStrategy),
// for the card's translations.
export function recommendStrategyKey(positioningLabel, redFlags, majorCompetitiveness) {
  if (positioningLabel === "Highly competitive") return "highly_competitive";
  if (positioningLabel === "Competitive") return majorCompetitiveness.capacityRiskFlag !== "normal" ? "competitive_capped" : "competitive";
  if (positioningLabel === "Reach") return redFlags.length > 0 ? "reach_gaps" : "reach_aspirational";
  return "high_reach";
}

export function recommendStrategy(positioningLabel, redFlags, majorCompetitiveness) {
  if (positioningLabel === "Highly competitive") return "Lean into fit, specificity, and proof of contribution. Avoid sounding generic because the academic case is already strong.";
  if (positioningLabel === "Competitive") return majorCompetitiveness.capacityRiskFlag !== "normal"
    ? "Present the application as academically ready but major-aware. Emphasize preparation, alternatives, and concrete evidence for the intended field."
    : "Strengthen school-specific fit and make the narrative more concrete. The academic floor is plausible; the decision may hinge on differentiation.";
  if (positioningLabel === "Reach") return redFlags.length > 0
    ? "Treat this as a selective reach. Fix the most visible preparation gaps and make the major story sharper and more school-specific."
    : "Treat this as an aspirational reach. Keep the school, but balance with more targets and use essays to maximize fit.";
  return "Treat this as a high reach. Keep only if it is emotionally worth it, and balance with a healthier college list.";
}

// The card-facing summary of the reads: what test was read and how it
// sits, each section against its band, the GPA against the average, band
// and distribution, the class rank against C10, and the AP exam evidence.
export function buildProfileComparison(reads) {
  if (!reads) return null;
  const { tests, gpa, classRank, apExams, rigor } = reads;
  const best = tests?.best || null;
  const brief = (c) => ({ test: c.test, score: c.score, convertedFrom: c.convertedFrom, equivalent: c.equivalent, band: c.band, position: c.position });
  return {
    tests: {
      policy: tests?.policy ?? null,
      // Test-blind or test-free: a score on file is not considered.
      blind: Boolean(tests?.blind),
      // The school's own statement of it this cycle, when the policy scout
      // has read one; otherwise the policy is the Common Data Set's.
      stated: tests?.stated ?? null,
      advice: tests?.advice ?? "none",
      used: best ? { ...brief(best), weakSection: best.weakSection } : null,
      sections: best ? best.sections.map((s) => ({ key: s.key, label: s.label, value: s.value, band: s.band, position: s.position })) : [],
      alternatives: (tests?.candidates || []).filter((c) => c !== best).map(brief),
      distribution: tests?.distribution ?? null,
      submitting: tests?.submitting ?? null,
      score: tests?.score ?? null,
    },
    gpa: gpa ? { gpa: gpa.gpa, weightedGpa: gpa.weightedGpa ?? null, average: gpa.average, averageScale: gpa.averageScale, comparedGpa: gpa.comparedGpa, band: gpa.band, position: gpa.position, placement: gpa.placement, basis: gpa.basis, note: gpa.note ?? null, score: gpa.score } : null,
    classRank: classRank ? { topPercent: classRank.topPercent, bucket: classRank.bucket, school: classRank.school, shareAbove: classRank.shareAbove, basis: classRank.basis, score: classRank.score } : null,
    apExams: apExams ? { count: apExams.count, average: apExams.average, strong: apExams.strong, weak: apExams.weak, relevant: apExams.relevant, relevantAverage: apExams.relevantAverage, score: apExams.score } : null,
    // The course load behind the rigor component: how many APs were taken
    // (courses, or exams no course names), how many carry exam scores, the
    // IB / dual-enrollment / A-Level courses, and the load against what the
    // admitted average implies.
    rigor: rigor ? { apTaken: rigor.apTaken, apCourses: rigor.apCourses, apExamsWithoutCourse: rigor.apExamsWithoutCourse, apScored: rigor.apScored, ib: rigor.ib, dualEnrollment: rigor.dualEnrollment, aLevel: rigor.aLevel, honors: rigor.honors, units: rigor.units, expectation: rigor.expectation, position: rigor.position, score: rigor.score } : null,
  };
}

export function buildPositioningForTarget(student, collegeContext, cdsResult, options = {}) {
  const academic = scoreAcademicReadiness(student, collegeContext, cdsResult);
  const selectivity = scoreInstitutionalSelectivityAdjustment(collegeContext);
  const majorComp = scoreMajorCompetitiveness(student, collegeContext, options);
  const fit = scoreInstitutionalPriorityFit(student, cdsResult);
  const narrative = scoreNarrativeFit(student);
  const differentiation = scoreDifferentiationStrength(student);
  const strategicFocus = scoreStrategicFocusBonus(options.strategicSignals || [], options.majorPolicy || null);
  const redFlagEntries = buildRedFlagEntries(student, collegeContext, majorComp, narrative, academic.reads);
  const redFlags = redFlagEntries.map((entry) => entry.text);

  // ── Displayed competitiveness blends intended-major crowding with the
  // school's ACTUAL institutional selectivity (admit rate). Previously the
  // displayed number came only from major demand, so a 4%-admit Ivy and a
  // 60%-admit state school scored identical competitiveness for the same
  // major — which reads as badly inflated for the selective school. The raw
  // major-pool signal is preserved separately for transparency. This uses the
  // selectivity INDEX (1 − rate); the composite instead applies the separate
  // inverse-proportional selectivity.adjustment once, below — different knobs,
  // so this does not double-count.
  const selectivityPressure = selectivity.selectivityIndex; // 0..1, null if admit rate unknown
  const displayedCompetitivenessScore = selectivityPressure != null
    ? round1((1 - clamp01(majorComp.difficultyIndex * 0.35 + selectivityPressure * 0.65)) * 100)
    : majorComp.score; // no selectivity data → fall back to the raw major-pool score

  const contextBonus = options.contextualAchievementBonus ?? 0;
  const redFlagPenalty = Math.min(24, redFlags.length * 5);
  const preSelectivityScore =
    (academic.score * (0.82 + ((majorComp.score / 100) * 0.33))) +
    (fit.score * 0.12) +
    (narrative.score * 0.08) +
    strategicFocus.bonus +
    contextBonus -
    redFlagPenalty;
  // The composite, normalized, is the student's readiness; the admit rate is
  // the base rate; the likelihood is the score and the label (see
  // admissionLikelihood). The selectivity adjustment is reported for
  // transparency and feeds the displayed competitiveness; it no longer
  // multiplies the score, which would count the admit rate twice.
  const readiness = round1(Math.max(0, Math.min(100, preSelectivityScore / 1.15)));
  const overallRate = normalizePercentValue(collegeContext.acceptanceRate ?? collegeContext.acceptance ?? collegeContext.admission_rate ?? null);
  // A student applying in the regular round starts from the admit rate
  // outside Early Decision when the school's counts give one
  // (admitRatePools); otherwise from the headline rate.
  const pools = collegeContext.admitRatePools || null;
  const regularRate = pools?.regular > 0 ? pools.regular : null;
  const admitRate = regularRate ?? (overallRate != null && overallRate > 0 ? overallRate : null);
  const admitRateBasis = regularRate != null ? "outside_early_decision" : admitRate != null ? "overall" : "unknown";
  const admitRateSummary = {
    used: admitRate != null ? round4(admitRate) : null,
    basis: admitRateBasis,
    overall: overallRate != null && overallRate > 0 ? round4(overallRate) : (pools?.overall ?? null),
    earlyDecision: pools?.earlyDecision ?? null,
    // An unknown rate is not hidden: the likelihood starts from 50% and
    // says so here, while `used` stays null.
    ...(admitRate == null ? { assumedForLikelihood: 0.5 } : {}),
  };
  const enoughStudentData = hasEnoughStudentData(student);
  const boundedFinal = enoughStudentData ? round1(admissionLikelihood({ readiness, admitRate }) * 100) : null;
  const gpaScaleUnknown = academic.reads?.gpa?.basis === "scale_unknown";
  const confidence = scoreEvidenceConfidence({
    cdsResult,
    collegeContext,
    majorPolicy: options.majorPolicy || null,
    ipedsGrowthAvailable: majorComp.ipedsGrowthProxy != null,
    studentEvidencePenalty: gpaScaleUnknown ? 0.06 : 0,
    now: options.now || new Date(),
  });
  const label = enoughStudentData ? classifyPositioningLabel(boundedFinal) : INSUFFICIENT_STUDENT_DATA.label;
  const labelKey = enoughStudentData ? positioningLabelKey(label) : INSUFFICIENT_STUDENT_DATA.labelKey;
  // What the student could add, and what the read could not place; the
  // card and the chat say these in their own words.
  const dataNotes = [];
  const dataNoteKeys = [];
  if (!enoughStudentData) { dataNotes.push("Add a GPA (unweighted or weighted) or an SAT or ACT score to see a likelihood for this school."); dataNoteKeys.push("add_gpa_or_test"); }
  if (gpaScaleUnknown) { dataNotes.push("Your unweighted GPA is above 4.0, so its scale is not known and it was read as at this school's average. Enter your GPA on a 4.0 scale as the unweighted GPA, and a weighted GPA in the weighted box."); dataNoteKeys.push("gpa_scale_unknown"); }
  if (admitRate == null) { dataNotes.push("No admit rate is on file for this school; the likelihood assumes 50% until one is."); dataNoteKeys.push("admit_rate_assumed"); }
  const summaryKey = !enoughStudentData ? "not_enough_data" : academic.score >= 80 ? "in_range" : academic.score >= 65 ? "plausible" : "stretched";

  // Honest uncertainty bands for the displayed dimensions, widened in
  // inverse proportion to evidence confidence. The confidence dimension
  // itself is not banded.
  const scoreRanges = {
    admissibility: confidenceBand(academic.score, confidence.normalized),
    competitiveness: confidenceBand(displayedCompetitivenessScore, confidence.normalized),
    fit: confidenceBand(fit.score, confidence.normalized),
  };

  return {
    schoolName: collegeContext.name || cdsResult?.schoolName || "Unknown school",
    intendedMajor: student.majorInterest || options.major || null,
    overallPositioningLabel: label,
    labelKey,
    // Null when the record holds too little to place (labelKey
    // "insufficient_student_data"): no likelihood is invented for it.
    finalPositioningScore: boundedFinal,
    studentDataNeeded: enoughStudentData ? [] : studentDataNeeded(student),
    dataNotes,
    // The same notes as stable keys, for the card's translations.
    dataNoteKeys,
    // The composite the likelihood was shifted by, and the base rate it
    // started from (null when the admit rate is unknown: 50% was assumed),
    // with what that rate is: the pool outside Early Decision when the CDS
    // counts give one, else the headline rate.
    readinessScore: readiness,
    admitRateUsed: admitRateSummary.used,
    admitRateBasis: admitRateBasis,
    admitRate: admitRateSummary,
    admissibility: {
      academicReadinessScore: academic.score,
      summary: {
        not_enough_data: "not enough academic data yet",
        in_range: "academically in-range",
        plausible: "academically plausible but not comfortable",
        stretched: "academically stretched",
      }[summaryKey],
      summaryKey,
    },
    competitiveness: {
      // Blended: intended-major crowding + the school's real admit-rate
      // selectivity. This is what the UI shows. Higher = more attainable.
      majorCompetitivenessScore: displayedCompetitivenessScore,
      // Raw intended-major-pool signal only (no institutional selectivity),
      // kept for transparency / explainability.
      majorPoolCompetitivenessScore: majorComp.score,
      institutionalSelectivityIndex: selectivityPressure,
      institutionalSelectivityAdjustment: selectivity.adjustment,
      majorCompetitivenessAdjustment: round2(0.82 + ((majorComp.score / 100) * 0.33)),
    },
    fit: {
      institutionalPriorityFitScore: fit.score,
      c7SignalsUsed: fit.c7SignalsUsed,
      strategicFocusBonus: strategicFocus.bonus,
      narrativeCoherenceScore: narrative.score,
      differentiationStrength: differentiation.score,
    },
    confidence: {
      evidenceConfidence: confidence.label,
      // "high" | "medium" | "low" | "very_low", for the card's translations.
      evidenceConfidenceKey: String(confidence.label).toLowerCase().replace(/\s+/g, "_"),
      evidenceConfidenceScore: confidence.score,
      evidenceValidated: confidence.validated,
    },
    scoreRanges,
    capacityRiskFlag: majorComp.capacityRiskFlag,
    mainRedFlags: redFlags,
    // The same flags as { code, params } for the card's translations; the
    // English sentences above stay what the chat quotes.
    mainRedFlagCodes: redFlagEntries.map(({ code, params }) => (params ? { code, params } : { code })),
    recommendedPositioningStrategy: enoughStudentData
      ? recommendStrategy(label, redFlags, majorComp)
      : "Add a GPA or an SAT/ACT score first; with neither on file there is nothing yet to place against this school's admitted class.",
    strategyKey: enoughStudentData ? recommendStrategyKey(label, redFlags, majorComp) : "add_academics",
    // How this student's own record compares with the enrolled class the
    // Common Data Set describes: the facts the readiness blend used.
    profileComparison: { ...buildProfileComparison(academic.reads), admitRate: admitRateSummary },
    featureBreakdown: {
      gpa: round1(student.gpa ?? 0),
      courseRigor: round1(academic.componentScores.rigorScore),
      majorRelevantCoursework: round1(academic.componentScores.majorPrepScore),
      testScorePercentile: round1(academic.componentScores.testScore),
      testSubmissionAdvice: academic.reads?.tests?.advice ?? null,
      apExamScore: round1(academic.componentScores.apExamScore),
      classRankScore: round1(academic.componentScores.rankScore),
      ecImpactTier: round1(student.ecImpactTier),
      ecMajorAlignment: round1(student.ecMajorAlignment),
      essayNarrativeCoherence: narrative.coherence,
      overallAdmitRate: collegeContext.acceptanceRate ?? cdsResult?.parsed?.admitRatePercent ?? null,
      cdsC7FactorWeights: cdsResult?.parsed?.c7 || {},
      appliedAcademicDynamicWeights: academic.dynamicWeights,
      satGpaEnrolledRange: {
        sat25: collegeContext.sat25 ?? null,
        sat75: collegeContext.sat75 ?? null,
        avgGpaAdmitted: collegeContext.avgGpaAdmitted ?? null,
      },
      ipedsCompletionsGrowthByCip: majorComp.ipedsGrowthProxy,
      cappedDirectAdmitRestrictedMajorFlag: options.majorPolicy?.policyType || null,
    },
    evidence: {
      cdsRepositoryMatch: cdsResult?.repositoryMatch || null,
      cdsSourceUrl: cdsResult?.sourceUrl || null,
      strategicSignals: options.strategicSignals || [],
      dataSources: [
        cdsResult?.source || "College Transitions CDS repository",
        collegeContext.source || "baseline_colleges",
      ].filter(Boolean),
    },
  };
}
