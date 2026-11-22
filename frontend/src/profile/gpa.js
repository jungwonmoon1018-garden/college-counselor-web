// gpa.js — the range a GPA may take, for the survey and the profile editor,
// and the one test for whether a record holds a GPA at all.
//
// The survey checked only that a GPA was typed and the profile editor only
// that it parsed as a number, so a missed decimal (39) or a 100-point
// average (95) was saved as the GPA and read by College Fit and the
// counselor. GPA_LIMITS mirrors backend/academics/profile-input.js, which
// refuses the same values on sync; backend tests/profile-input.test.js pins
// the two copies together.

import { GRADE_SCALE } from "../app-shared.js";

export const GPA_LIMITS = Object.freeze({
  unweighted: Object.freeze({ min: 0, max: 5 }),
  weighted: Object.freeze({ min: 0, max: 6 }),
});

const NUMERIC_TEXT = /^\s*\d+(?:\.\d+)?\s*$/;

const isBlank = (value) => value == null || String(value).trim() === "";

// The number a field holds, or null when it is blank or not a number.
export function gpaNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return NUMERIC_TEXT.test(String(value ?? "")) ? Number(value) : null;
}

// A GPA the record actually holds: an unweighted or a weighted number. The
// profile route answers { unweighted: null, weighted: null } for a student
// with no GPA, and every truthiness check (`profile.gpa ? …`) read that object
// as a GPA, so the sidebar showed an empty GPA card and the profile quick
// reply said "GPA: null".
export function hasGpa(gpa) {
  if (!gpa || typeof gpa !== "object") return false;
  return gpaNumber(gpa.unweighted) != null || gpaNumber(gpa.weighted) != null;
}

// The GPA with each part read as a number, or null when neither part is one.
// Other keys the object carries are kept.
export function normalizeGpa(gpa) {
  if (!hasGpa(gpa)) return null;
  return { ...gpa, unweighted: gpaNumber(gpa.unweighted), weighted: gpaNumber(gpa.weighted) };
}

// The GPA as a student reads it. A part that is missing is said to be "not
// entered" rather than printed as blank or as "null".
export function formatGpa(gpa) {
  const value = normalizeGpa(gpa);
  if (!value) return "not entered";
  if (value.unweighted == null) return `${value.weighted}w (unweighted not entered)`;
  return value.weighted == null ? String(value.unweighted) : `${value.unweighted} / ${value.weighted}w`;
}

// Blank fields are not errors here (the survey asks for an unweighted GPA
// separately); a value that is typed must be a number in range. Returns the
// problems as sentences a student can act on.
export function validateGpa({ unweighted, weighted } = {}) {
  const errors = [];
  if (!isBlank(unweighted)) {
    const value = gpaNumber(unweighted);
    if (value == null) errors.push("Enter your GPA as a number, like 3.75.");
    else if (value < GPA_LIMITS.unweighted.min || value > GPA_LIMITS.unweighted.max) {
      errors.push("An unweighted GPA is between 0 and 5, like 3.75. If your school grades out of 100, use the 4.0-scale GPA on your transcript if it has one.");
    }
  }
  if (!isBlank(weighted)) {
    const value = gpaNumber(weighted);
    if (value == null) errors.push("Enter your weighted GPA as a number, like 4.20, or leave it blank.");
    else if (value < GPA_LIMITS.weighted.min || value > GPA_LIMITS.weighted.max) {
      errors.push("A weighted GPA is between 0 and 6. Leave it blank if you're not sure.");
    }
  }
  return { ok: errors.length === 0, errors };
}

// ─── The GPA the course list implies ───
// Moved from Sidebar.jsx on 2026-11-22. Unweighted on the 4.0 scale,
// weighted with the course form's rigor bonuses (AP, IB and dual enrollment
// +1.0, honors +0.5). Rows with no letter or number grade (IP, W, P, no
// grade recorded) are left out. A semester row is half a course: a course
// graded each semester is two rows, and counting each as a whole course
// gave it twice the weight of a full-year one.
const GPA_POINTS = { "A+":4.0, "A":4.0, "A-":3.7, "B+":3.3, "B":3.0, "B-":2.7, "C+":2.3, "C":2.0, "C-":1.7, "D+":1.3, "D":1.0, "D-":0.7, "F":0.0 };
const GPA_WEIGHT_BONUS = { honors: 0.5, ap: 1.0, ib: 1.0, dual_enrollment: 1.0 };

export function gpaPointsForGrade(grade) {
  if (grade == null || grade === "") return null;
  const s = String(grade).trim().toUpperCase();
  if (s in GPA_POINTS) return GPA_POINTS[s];
  if (["IP", "W", "P", "NP", "CR", "NC", "AUDIT"].includes(s)) return null;
  const num = parseFloat(s);
  if (Number.isFinite(num)) {
    if (num <= 5) return Math.min(4, num);
    const band = GRADE_SCALE.find((e) => num >= e.min && num <= e.max);
    if (band) return GPA_POINTS[band.grade] ?? null;
  }
  return null;
}

export function computeGpaFromCourses(courses) {
  let sumU = 0;
  let sumW = 0;
  let weight = 0;
  let count = 0;
  for (const c of courses || []) {
    const pts = gpaPointsForGrade(c?.grade);
    if (pts == null) continue;
    const term = String(c?.semester || "").toLowerCase();
    const share = term === "fall" || term === "spring" ? 0.5 : 1;
    const bonus = GPA_WEIGHT_BONUS[String(c?.type || "").toLowerCase()] || 0;
    sumU += pts * share;
    sumW += (pts + bonus) * share;
    weight += share;
    count += 1;
  }
  if (!weight) return null;
  return {
    unweighted: Math.round((sumU / weight) * 100) / 100,
    weighted: Math.round((sumW / weight) * 100) / 100,
    count,
  };
}

// What the student is asked before the calculation replaces a saved GPA,
// or null when nothing would change (or nothing is saved). The button used
// to overwrite in one click: the transcript's GPA gave way to this average,
// which put every grade on one scale, it synced, and College Fit and the
// fidelity check then held the student to the estimate.
export function gpaReplacementQuestion(saved, computed) {
  const current = normalizeGpa(saved);
  if (!current || !computed) return null;
  const sameWeighted = current.weighted == null || current.weighted === computed.weighted;
  if (current.unweighted === computed.unweighted && sameWeighted) return null;
  const entries = `${computed.count} graded course entr${computed.count === 1 ? "y" : "ies"}`;
  return `Replace your saved GPA (${formatGpa(current)}) with ${computed.unweighted} / ${computed.weighted}w, the average of ${entries}?\n\n`
    + "The GPA your school prints on your transcript is the one colleges read, so keep it unless it is out of date. "
    + "This average puts every grade on one scale (A+ and A as 4.0, honors +0.5, AP, IB and dual enrollment +1.0), which may not be your school's.";
}
