// gpa.js — the range a GPA may take, for the survey and the profile editor.
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
