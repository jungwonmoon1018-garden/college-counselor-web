// ═══════════════════════════════════════════════════════════════════════
// PROFILE INPUT — what a profile sync may store.
// ═══════════════════════════════════════════════════════════════════════
// POST /api/students/sync stored the body as sent. The student app checks
// its forms, but a value from an older build, a hand-written request, or a
// vault saved before a form gained its check went straight into the
// snapshot, the STUDENT PROFILE block and College Fit: a GPA of 39 (a
// missed decimal) or 95 (a 100-point average), an SAT of 1700, an AP score
// of 9. A GPA sent as text, or a course list that was not a list, crashed
// the whole save with a 500 instead.
//
// Every field is checked here before the snapshot is written. A value
// that cannot be stored is set aside and named in `setAside`, so the app
// can tell the student and the rest of the save still lands:
//   • a GPA out of range or not a number keeps the last stored GPA;
//   • a list field that is not a list keeps the last stored list;
//   • a bad entry inside a list (a test score outside its range, an AP
//     score that is not 1–5, an entry that is not an object) is dropped.
// A field that is simply absent keeps today's meaning (no GPA, empty list).
// The frontend mirrors GPA_LIMITS in src/profile/gpa.js;
// tests/profile-input.test.js pins the two copies together.

import { normalizeTestScores, normalizeClassRank } from "./test-catalog.js";
import { apFirstExamYear } from "./ap-exams.js";

// Unweighted GPAs are reported on 4.0, 4.3 or 5.0 scales (transcript import
// accepts the same 0–5); weighted scales reach 5.0 or 6.0.
export const GPA_LIMITS = Object.freeze({
  unweighted: Object.freeze({ min: 0, max: 5 }),
  weighted: Object.freeze({ min: 0, max: 6 }),
});

const NUMERIC_TEXT = /^\s*-?\d+(?:\.\d+)?\s*$/;

// A finite number, or numeric text such as "3.85"; anything else is null.
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && NUMERIC_TEXT.test(value)) return Number(value);
  return null;
}

const isPlainObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);

function gpaPart(raw, limits, previous, field, setAside) {
  if (raw == null || raw === "") return null;
  const value = toNumber(raw);
  if (value == null) {
    setAside.push({ field, reason: "not_a_number" });
    return keepPrevious(previous, limits);
  }
  if (value < limits.min || value > limits.max) {
    setAside.push({ field, reason: "out_of_range" });
    return keepPrevious(previous, limits);
  }
  return Math.round(value * 100) / 100;
}

// The last stored value stands in for one that was set aside, unless it is
// itself out of range (stored before these checks existed).
function keepPrevious(previous, limits) {
  const value = toNumber(previous);
  return value != null && value >= limits.min && value <= limits.max ? value : null;
}

function listField(raw, previous, field, setAside) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  setAside.push({ field, reason: "not_a_list" });
  return Array.isArray(previous) ? previous : [];
}

function dropInvalid(list, keep, field, setAside) {
  const out = list.filter(keep);
  if (out.length < list.length) setAside.push({ field, reason: "invalid_entry", count: list.length - out.length });
  return out;
}

// AP exam scores: a whole score 1–5 for a named exam (an entry with no exam
// name says nothing and is dropped). The year is kept when a score from it
// can exist, from the exam's first year (2000, or later for the newest
// exams in ap-exams.js) through the current year; another year is dropped
// and the entry kept. Until 2026-10-09 any year to 2100 was kept.
function normalizeApScores(list, now = new Date()) {
  const latest = now.getUTCFullYear();
  const out = [];
  for (const raw of list) {
    if (!isPlainObject(raw)) continue;
    const name = String(raw.exam ?? raw.subject ?? raw.name ?? "").trim();
    if (!name) continue;
    const score = toNumber(raw.score);
    if (score == null || !Number.isInteger(score) || score < 1 || score > 5) continue;
    const entry = { ...raw, score };
    const year = toNumber(raw.year);
    const first = Math.max(2000, apFirstExamYear(name) ?? 2000);
    if (year != null && Number.isInteger(year) && year >= first && year <= latest) entry.year = year;
    else delete entry.year;
    out.push(entry);
  }
  return out;
}

/**
 * Check a sync body before it is stored.
 * @param {object} input    { profile, activities, goals, majorInterest } as sent
 * @param {object} previous the last stored values (from the latest snapshot):
 *                          { gpaUnweighted, gpaWeighted, courses, activities,
 *                            goals, majorInterest }
 * @param {object} options  { now }: the clock an AP score's year is checked against
 * @returns {{ profile, activities, goals, majorInterest, setAside: Array<{field, reason, count?}> }}
 */
export function normalizeSyncInput({ profile, activities, goals, majorInterest } = {}, previous = {}, { now = new Date() } = {}) {
  const setAside = [];
  const source = isPlainObject(profile) ? profile : {};
  if (profile != null && !isPlainObject(profile)) setAside.push({ field: "profile", reason: "not_an_object" });

  const out = { ...source };

  // GPA: both parts checked on their own; an absent GPA stays absent.
  if (isPlainObject(source.gpa)) {
    const unweighted = gpaPart(source.gpa.unweighted, GPA_LIMITS.unweighted, previous.gpaUnweighted, "gpa.unweighted", setAside);
    const weighted = gpaPart(source.gpa.weighted, GPA_LIMITS.weighted, previous.gpaWeighted, "gpa.weighted", setAside);
    out.gpa = unweighted == null && weighted == null ? null : { ...source.gpa, unweighted, weighted };
  } else if (source.gpa != null) {
    setAside.push({ field: "gpa", reason: "not_an_object" });
    const unweighted = keepPrevious(previous.gpaUnweighted, GPA_LIMITS.unweighted);
    const weighted = keepPrevious(previous.gpaWeighted, GPA_LIMITS.weighted);
    out.gpa = unweighted == null && weighted == null ? null : { unweighted, weighted };
  }

  // Courses: a list of objects.
  out.courses = dropInvalid(listField(source.courses, previous.courses, "courses", setAside), isPlainObject, "courses", setAside);

  // Test scores: the catalog's ranges and section sums (normalizeTestScores
  // drops what fails them); a list that is not a list is set aside whole.
  if (source.testScores != null && !Array.isArray(source.testScores)) {
    setAside.push({ field: "testScores", reason: "not_a_list" });
    out.testScores = [];
  } else {
    const sent = Array.isArray(source.testScores) ? source.testScores : [];
    out.testScores = normalizeTestScores(sent);
    if (out.testScores.length < sent.length) setAside.push({ field: "testScores", reason: "invalid_entry", count: sent.length - out.testScores.length });
  }

  // AP exam scores: whole numbers 1–5 for a named exam; a year no score can
  // come from is dropped from its entry, not the entry itself.
  if (source.apScores != null && !Array.isArray(source.apScores)) {
    setAside.push({ field: "apScores", reason: "not_a_list" });
    out.apScores = [];
  } else {
    const sent = Array.isArray(source.apScores) ? source.apScores : [];
    out.apScores = normalizeApScores(sent, now);
    if (out.apScores.length < sent.length) setAside.push({ field: "apScores", reason: "invalid_entry", count: sent.length - out.apScores.length });
  }

  // Class rank: syncStudentData stores normalizeClassRank's reading; a rank
  // that reads as nothing (past the end of the class, a share over 100%) is
  // named here so the student hears about it.
  if (source.classRank != null && normalizeClassRank(source.classRank) == null) {
    setAside.push({ field: "classRank", reason: "out_of_range" });
  }

  const outActivities = dropInvalid(listField(activities, previous.activities, "activities", setAside), isPlainObject, "activities", setAside);
  const outGoals = dropInvalid(
    listField(goals, previous.goals, "goals", setAside),
    (g) => (typeof g === "string" && g.trim() !== "") || isPlainObject(g),
    "goals",
    setAside,
  );

  let outMajor = null;
  if (typeof majorInterest === "string") outMajor = majorInterest.trim() || null;
  else if (majorInterest != null) {
    setAside.push({ field: "majorInterest", reason: "not_text" });
    outMajor = typeof previous.majorInterest === "string" ? previous.majorInterest : null;
  }

  return { profile: out, activities: outActivities, goals: outGoals, majorInterest: outMajor, setAside };
}

// The last stored values, read from a profile_snapshots row.
export function previousFromSnapshot(row, parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } }) {
  if (!row) return {};
  return {
    gpaUnweighted: row.gpa_unweighted,
    gpaWeighted: row.gpa_weighted,
    courses: parse(row.courses_json, []),
    activities: parse(row.activities_json, []),
    goals: parse(row.goals_json, []),
    majorInterest: row.major_interest,
  };
}
