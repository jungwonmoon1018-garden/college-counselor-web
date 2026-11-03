// gpa.js — the range a GPA may take, for the survey and the profile editor,
// and the one test for whether a record holds a GPA at all.
//
// The survey checked only that a GPA was typed and the profile editor only
// that it parsed as a number, so a missed decimal (39) or a 100-point
// average (95) was saved as the GPA and read by College Fit and the
// counselor. GPA_LIMITS mirrors backend/academics/profile-input.js, which
// refuses the same values on sync; backend tests/profile-input.test.js pins
// the two copies together.

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
