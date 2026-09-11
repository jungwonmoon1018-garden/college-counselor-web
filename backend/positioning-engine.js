import { clamp01, matchMajorBucket } from "./ec-vectorizer.js";
import { normalizeClassRank, sectionEntries } from "./test-catalog.js";
import { readCourseRigor } from "./course-rigor.js";

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
  computer_science: ["computer science", "cs", "programming", "software", "data structures", "algorithms", "machine learning", "python", "java", "javascript", "ap computer science"],
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
});

function round1(x) {
  return Math.round(Number(x || 0) * 10) / 10;
}

function round2(x) {
  return Math.round(Number(x || 0) * 100) / 100;
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

function getMajorKeywords(major) {
  const bucket = matchMajorBucket(major || "");
  return { bucket, keywords: MAJOR_KEYWORDS[bucket] || [] };
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
// "Physics").
function summarizeApExams(apScores, keywords = []) {
  const exams = (Array.isArray(apScores) ? apScores : [])
    .map((a) => ({ name: String(a?.exam || a?.subject || a?.name || "").trim(), score: Number(a?.score) }))
    .filter((a) => a.name && Number.isFinite(a.score) && a.score >= 1 && a.score <= 5);
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
  const satEntry = testScores.find((t) => String(t?.test || "").toLowerCase() === "sat") || null;
  const actEntry = testScores.find((t) => String(t?.test || "").toLowerCase() === "act") || null;
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

  const relevantCourses = courses.filter((course) => {
    const name = normalizeCourseName(course);
    return keywords.some((kw) => name.includes(kw));
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
  const narrativeCoherence = narrative
    ? round1(clamp01(avg(strengthRows.map((row) => Number(row.narrative_fit || 0))) || 0.35) * 100)
    : 25;

  return {
    gpa,
    weightedGpa,
    sat,
    act,
    satSections,
    actSections,
    classRank,
    apExams,
    rankPercentile,
    courses,
    relevantCourses,
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

export function compareTestsToSchool(student, college, cdsResult) {
  const parsed = cdsResult?.parsed || {};
  const policy = parsed.testPolicy || "test_considered_or_required";
  const optional = policy === "test_optional_or_deemphasized";
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
  // a test-optional school (42), low where tests are required (18). A
  // score the student would withhold at a test-optional school (below the
  // 25th percentile) counts no worse than no score.
  const baseline = optional ? 42 : 18;
  let advice = "none";
  let score = baseline;
  if (best) {
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
export function compareGpaToSchool(student, college, cdsResult) {
  const parsed = cdsResult?.parsed || {};
  const average = numberOrNull(college?.avgGpaAdmitted ?? college?.avg_gpa_admitted ?? parsed.gpaAverage);
  const band = bandOf(parsed.gpaBand?.low, parsed.gpaBand?.high);
  const rows = Array.isArray(parsed.gpaDistribution) && parsed.gpaDistribution.length ? parsed.gpaDistribution : null;
  const gpa = student.gpa;
  // An average above 4.0 is a weighted one (Harvard reports 4.21): it is
  // compared with the student's weighted GPA, or capped at 4.0 when the
  // student has none, never with the unweighted GPA it would dwarf.
  const weightedScale = average != null && average > 4;
  const gpaForAverage = weightedScale ? (student.weightedGpa ?? gpa) : gpa;
  // Tighter than before but not punitive: at the admitted average ≈54, ~0.2
  // above ≈85, ~0.2 below ≈23. No-GPA default 30.
  const target = weightedScale && student.weightedGpa == null ? 4 : (average ?? 3.75);
  const formulaScore = gpaForAverage != null ? clamp01((gpaForAverage - (target - 0.35)) / 0.65) * 100 : 30;
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
  if (gpa == null) { score = formulaScore; basis = "none"; }
  else if (average != null && distributionScore != null) { score = formulaScore * 0.6 + distributionScore * 0.4; basis = "average+distribution"; }
  else if (average != null) { score = formulaScore; basis = "average"; }
  else if (distributionScore != null) { score = bandScore != null ? distributionScore * 0.5 + bandScore * 0.5 : distributionScore; basis = "distribution"; }
  else if (bandScore != null) { score = bandScore; basis = "band"; }
  else { score = formulaScore; basis = "default"; }
  const position = gpa == null
    ? "unknown"
    : (band ? positionLabel(gpa, band) : (average != null && gpaForAverage != null ? (gpaForAverage >= target + 0.05 ? "above" : gpaForAverage >= target - 0.1 ? "within" : "below") : "unknown"));
  return {
    gpa,
    average,
    averageScale: average == null ? null : (weightedScale ? "weighted" : "unweighted"),
    comparedGpa: gpaForAverage,
    band,
    position,
    placement,
    basis,
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
// its exam score, honors at half a unit — plus half a unit per
// senior-year college-level course.
// Meeting the expectation reads "above" (the load is there), sixty percent
// of it "within", less "below".
export function compareCourseRigor(student, averageGpa = null) {
  const rigor = student?.rigor || readCourseRigor(student?.courses || [], []);
  const targetGpa = Math.min(4, averageGpa ?? 3.75);
  const expectation = Math.max(4, Math.round((targetGpa - 3.2) * 10));
  const units = Number(student?.rigorUnits ?? rigor.units ?? 0) + Number(student?.seniorRigorCount || 0) * 0.5;
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
  const gpaRead = compareGpaToSchool(student, college, cdsResult);
  const rankRead = compareRankToSchool(student, cdsResult);
  const apRead = compareApExams(student);
  const rigorRead = compareCourseRigor(student, gpaRead.average);
  const featureWeights = {
    gpa: 0.27 + 0.08 * c7Value(c7, ["academicGpa", "academic_gpa", "gpa"], 0.7),
    rigor: 0.2 + 0.08 * c7Value(c7, ["rigor"], 0.7),
    majorPrep: 0.18,
    // A score the student would withhold at a test-optional school is
    // never read, so the other evidence carries its weight.
    test: tests.advice === "withhold" ? 0 : 0.14 + 0.08 * c7Value(c7, ["standardizedTests", "standardized_tests", "test_scores"], 0.35),
    // AP exam results count once the student has any; before the first
    // exam the component is absent rather than a penalty.
    apExams: apRead.score != null ? 0.06 : 0,
    awards: 0.08,
    trend: 0.07,
    rank: 0.06 + 0.03 * c7Value(c7, ["classRank", "class_rank"], 0.35),
  };
  const totalWeight = Object.values(featureWeights).reduce((a, b) => a + b, 0);
  for (const key of Object.keys(featureWeights)) featureWeights[key] /= totalWeight;

  const gpaScore = gpaRead.score;
  const rigorScore = rigorRead.score;
  const majorPrepScore = clamp01(((student.relevantCourses.length / 5) * 0.55) + (((student.majorRelevantGpa ?? student.gpa ?? 3.2) / 4) * 0.45)) * 100;
  const testScore = tests.score;
  const apExamScore = apRead.score ?? 0;
  const awardsScore = Math.min(100, student.academicAwardsCount * 18 + 25);
  const trendScore = 60;
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
  const bucket = student.majorBucket;
  const baseDemand = MAJOR_DEMAND_BASE[bucket] ?? 0.6;
  const ipedsGrowth = options.ipedsGrowthByBucket?.[bucket] ?? IPEDS_CIP_GROWTH_PROXY[bucket] ?? null;
  const schoolSpecificSaturation = (() => {
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

  const ecStrength = clamp01((student.ecImpactTier - 1) / 4) * 100;
  const majorAlignment = clamp01(student.ecMajorAlignment / 100) * 100;
  const narrative = clamp01(student.narrativeCoherence / 100) * 100;
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
  const coherence = round1(student.narrativeCoherence);
  const specificity = round1((student.ecMajorAlignment * 0.55) + (clamp01((student.relevantCourses.length || 0) / 5) * 45));
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

export function scoreEvidenceConfidence({ cdsResult, collegeContext, majorPolicy, ipedsGrowthAvailable }) {
  const sourceQuality = cdsResult?.sourceUrl ? 0.78 : 0.5;
  const directness = cdsResult?.fetchStatus === "ok" ? 0.82 : cdsResult?.fetchStatus === "listed_without_direct_link" ? 0.35 : 0.2;
  const recency = cdsResult?.repositoryMatch?.latestAvailableYear?.startsWith("2024") ? 0.85 : 0.68;
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
  const isUnvalidated = cdsResult?.validated === false;
  const unvalidatedPenalty = isUnvalidated ? 0.12 : 0;
  const raw = sourceQuality * 0.28 + recency * 0.18 + directness * 0.22 + consistency * 0.2 - missingDataPenalty - marketingLanguagePenalty - unvalidatedPenalty;
  let normalized = clamp01(raw);
  if (isUnvalidated) normalized = Math.min(normalized, 0.74); // never "High" while unverified
  const label = normalized >= 0.78 ? "High" : normalized >= 0.58 ? "Medium" : normalized >= 0.35 ? "Low" : "Very Low";
  return { score: round1(normalized * 100), label, normalized: round2(normalized), validated: !isUnvalidated };
}

const QUANTITATIVE_BUCKETS = new Set(["computer_science", "data_science", "computational_biology", "biomedical_engineering", "engineering", "mathematics", "physics", "chemistry", "economics"]);

export function buildRedFlags(student, collegeContext, majorCompetitiveness, narrativeFit, reads = null) {
  const flags = [];
  // A math section under the school's 25th percentile is the number a
  // quantitative department reads first, whatever the total says.
  const best = reads?.tests?.best;
  if (best && QUANTITATIVE_BUCKETS.has(student.majorBucket)) {
    const mathSection = (best.sections || []).find((s) => s.key === "math");
    if (mathSection?.position === "below") {
      flags.push(`${best.test.toUpperCase()} Math (${mathSection.value}) sits below this school's 25th percentile (${mathSection.band.low}), which a quantitative major will notice.`);
    }
  }
  if (reads?.apExams?.relevant?.length && reads.apExams.relevantAverage != null && reads.apExams.relevantAverage < 3) {
    flags.push("AP exam scores in the intended field average below 3.");
  }
  if (student.relevantCourses.length <= 1 && ["computer_science", "engineering", "computational_biology", "data_science", "business"].includes(student.majorBucket)) {
    flags.push("Weak major-relevant coursework for an ambitious intended major.");
  }
  if (student.activities.length >= 8 && student.strengthRows.length > 0 && (avg(student.strengthRows.map((row) => Number(row.dedication || 0))) || 0) < 0.35) {
    flags.push("Many shallow extracurriculars without enough sustained depth.");
  }
  if ((student.majorInterest || "").match(/\b(ai|medicine|business)\b/i) && narrativeFit.specificity < 45) {
    flags.push("Narrative risks sounding generic for a crowded major lane.");
  }
  if (narrativeFit.coherence < 45) {
    flags.push("Narrative coherence is weak and may read as a list rather than a story.");
  }
  if (majorCompetitiveness.capacityRiskFlag !== "normal" && student.relevantCourses.length <= 2) {
    flags.push("Applying to a capped or capacity-constrained major without enough preparation.");
  }
  if ((collegeContext.acceptanceRate ?? 100) < 15 && student.gpa != null && (collegeContext.avgGpaAdmitted ?? 3.9) - student.gpa > 0.2) {
    flags.push("Transcript looks light relative to this university's admitted academic range.");
  }
  return flags;
}

export function classifyPositioningLabel(finalScore) {
  // Raised cutoffs (was 82/67/48). "Competitive" now requires a genuinely
  // in-range profile rather than a merely plausible one — the labels were
  // reading too optimistically.
  if (finalScore >= 85) return "Highly competitive";
  if (finalScore >= 70) return "Competitive";
  if (finalScore >= 52) return "Reach";
  return "High reach";
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
      advice: tests?.advice ?? "none",
      used: best ? { ...brief(best), weakSection: best.weakSection } : null,
      sections: best ? best.sections.map((s) => ({ key: s.key, label: s.label, value: s.value, band: s.band, position: s.position })) : [],
      alternatives: (tests?.candidates || []).filter((c) => c !== best).map(brief),
      distribution: tests?.distribution ?? null,
      submitting: tests?.submitting ?? null,
      score: tests?.score ?? null,
    },
    gpa: gpa ? { gpa: gpa.gpa, average: gpa.average, averageScale: gpa.averageScale, comparedGpa: gpa.comparedGpa, band: gpa.band, position: gpa.position, placement: gpa.placement, basis: gpa.basis, score: gpa.score } : null,
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
  const redFlags = buildRedFlags(student, collegeContext, majorComp, narrative, academic.reads);

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
  // Devalue the COMPOSITE inversely proportional to the acceptance rate (see
  // scoreInstitutionalSelectivityAdjustment). Applied once, to the whole score
  // rather than only the academic sub-score, so a hyper-selective school's
  // composite is discounted as a whole and selectivity isn't double-counted.
  const finalScore = (preSelectivityScore / 1.15) * selectivity.adjustment;
  const boundedFinal = round1(Math.max(0, Math.min(100, finalScore)));
  const confidence = scoreEvidenceConfidence({
    cdsResult,
    collegeContext,
    majorPolicy: options.majorPolicy || null,
    ipedsGrowthAvailable: majorComp.ipedsGrowthProxy != null,
  });
  const label = classifyPositioningLabel(boundedFinal);

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
    finalPositioningScore: boundedFinal,
    admissibility: {
      academicReadinessScore: academic.score,
      summary: academic.score >= 80 ? "academically in-range" : academic.score >= 65 ? "academically plausible but not comfortable" : "academically stretched",
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
      evidenceConfidenceScore: confidence.score,
      evidenceValidated: confidence.validated,
    },
    scoreRanges,
    capacityRiskFlag: majorComp.capacityRiskFlag,
    mainRedFlags: redFlags,
    recommendedPositioningStrategy: recommendStrategy(label, redFlags, majorComp),
    // How this student's own record compares with the enrolled class the
    // Common Data Set describes: the facts the readiness blend used.
    profileComparison: buildProfileComparison(academic.reads),
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
