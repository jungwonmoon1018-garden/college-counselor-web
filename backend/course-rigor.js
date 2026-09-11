// Course rigor, read the same way everywhere the College Fit machinery
// looks at the transcript: the positioning engine's rigor component, the
// "How your record compares" block, and the priorities matrix. AP, IB,
// dual-enrollment and A-Level courses carry a unit each (an AP more or
// less by its exam score), honors courses half a unit, and a college-level
// course taken in senior year half a unit more; `units` is that one total
// wherever it is shown.
//
// Two things used to go unread. A course's level was taken only from its
// `type` field, so "AP Calculus BC" entered as a regular course (a
// transcript upload, or a student who never touched the type picker) was
// not rigorous; and AP exam results were a separate six-percent component,
// so a student whose AP work lived only in their exam list — or who took
// the exams without listing the courses — had no course rigor at all. Here
// a course is college-level by its type or its name, an AP exam whose
// subject no listed course names counts as an AP taken, and each AP's exam
// score lifts or lowers the weight it carries (a 5 is stronger evidence of
// handling college-level work than an unscored course; a 1 is weaker).

const LEVEL_BY_TYPE = Object.freeze({
  ap: "ap",
  ib: "ib",
  dual_enrollment: "dual_enrollment",
  "dual enrollment": "dual_enrollment",
  de: "dual_enrollment",
  "a-level": "a_level",
  alevel: "a_level",
  a_level: "a_level",
  honors: "honors",
  honor: "honors",
});

export const LEVEL_LABELS = Object.freeze({
  ap: "AP",
  ib: "IB",
  dual_enrollment: "Dual enrollment",
  a_level: "A-Level",
  honors: "Honors",
});

// The weight one AP carries toward the rigor read, by exam score. An AP
// without an exam result (in progress, or not yet reported) counts as one
// course taken.
export const AP_SCORE_WEIGHT = Object.freeze({ 5: 1.2, 4: 1.1, 3: 1, 2: 0.8, 1: 0.6 });
// An honors course is harder than the standard section but not
// college-level work, so it carries half a unit (the owner's call,
// 2026-09-11; before that honors were counted and weighed nothing).
export const HONORS_WEIGHT = 0.5;
// Half a unit more for each college-level course taken in senior year.
export const SENIOR_YEAR_CREDIT = 0.5;

const COLLEGE_LEVEL = new Set(["ap", "ib", "dual_enrollment", "a_level"]);

// The level of one course: its type when the type says so, otherwise its
// name ("AP Biology", "IB Chemistry HL", "Honors English", "Dual Enrollment
// Calculus"). A name is read only for a prefix or a whole-word level so
// "Apparel Design" is never AP and "Liberal Arts" never IB.
export function courseLevel(course) {
  if (!course) return null;
  const type = String(course.type ?? course.level ?? "").trim().toLowerCase();
  if (LEVEL_BY_TYPE[type]) return LEVEL_BY_TYPE[type];
  const name = String(course.name || "").trim();
  if (!name) return null;
  if (/^ap\b/i.test(name) || /\badvanced placement\b/i.test(name)) return "ap";
  if (/^ib\b/i.test(name) || (/\b(?:hl|sl)\b/i.test(name) && /\bib\b/i.test(name))) return "ib";
  if (/\bdual[- ]enrol?l?ment\b/i.test(name) || /\b(?:college|university) credit\b/i.test(name)) return "dual_enrollment";
  if (/\ba[- ]level\b/i.test(name)) return "a_level";
  if (/\bhonou?rs?\b/i.test(name)) return "honors";
  return null;
}

export function isCollegeLevel(course) {
  return COLLEGE_LEVEL.has(courseLevel(course));
}

// "AP Calculus BC" and "Calculus BC" name the same subject; so do
// "Physics C: Mechanics" and "AP Physics C Mechanics".
export function normalizeApSubject(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\badvanced placement\b/g, " ")
    .replace(/^\s*ap\b/g, " ")
    .replace(/\bap\b/g, " ")
    .replace(/\b(?:exam|examination|test|course)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameSubject(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // One name inside the other, at a word boundary: "physics c" is
  // "physics c mechanics", but "calculus ab" is not "calculus bc".
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return new RegExp(`(?:^|\\s)${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(long);
}

function examScore(entry) {
  const score = Number(entry?.score);
  return Number.isFinite(score) && score >= 1 && score <= 5 ? score : null;
}

/**
 * Read the rigor of a transcript.
 *
 * @param {Array} courses — profile course rows ({ name, type, grade, year }).
 * @param {Array} apScores — profile AP exam rows ({ exam|subject|name, score }).
 * @returns {{
 *   units: number,                // weighted load: honors at half a unit,
 *                                 // plus half a unit per senior-year
 *                                 // college-level course
 *   apTaken: number,              // AP courses + AP exams no course names
 *   apCourses: number, apExamsWithoutCourse: number, apScored: number,
 *   ib: number, dualEnrollment: number, aLevel: number, honors: number,
 *   collegeLevelCourses: number,  // AP + IB + dual enrollment + A-Level courses
 *   seniorCollegeLevel: number,   // of those, the senior-year ones
 *   items: Array<{ name, level, source, examScore, weight }>,
 * }}
 */
export function readCourseRigor(courses, apScores) {
  const exams = (Array.isArray(apScores) ? apScores : [])
    .map((a) => ({ name: String(a?.exam || a?.subject || a?.name || "").trim(), score: examScore(a) }))
    .filter((a) => a.name)
    .map((a) => ({ ...a, subject: normalizeApSubject(a.name), used: false }));

  const items = [];
  const counts = { ap: 0, ib: 0, dual_enrollment: 0, a_level: 0, honors: 0 };
  let seniorCollegeLevel = 0;
  for (const course of Array.isArray(courses) ? courses : []) {
    const level = courseLevel(course);
    if (!level) continue;
    counts[level] += 1;
    if (level === "honors") {
      items.push({ name: String(course?.name || "").trim(), level, source: "course", examScore: null, weight: HONORS_WEIGHT });
      continue;
    }
    const year = String(course?.year || course?.gradeLevel || "").toLowerCase();
    if (/(12|senior)/.test(year)) seniorCollegeLevel += 1;
    let score = null;
    if (level === "ap") {
      const subject = normalizeApSubject(course.name);
      const exam = exams.find((e) => !e.used && sameSubject(e.subject, subject));
      if (exam) { exam.used = true; score = exam.score; }
    }
    items.push({
      name: String(course?.name || "").trim(),
      level,
      source: "course",
      examScore: score,
      weight: score != null ? AP_SCORE_WEIGHT[score] : 1,
    });
  }
  // An AP exam whose subject no course names is an AP taken all the same
  // (self-studied, or a course the student never listed).
  let apExamsWithoutCourse = 0;
  for (const exam of exams) {
    if (exam.used) continue;
    apExamsWithoutCourse += 1;
    items.push({
      name: exam.name,
      level: "ap",
      source: "exam",
      examScore: exam.score,
      weight: exam.score != null ? AP_SCORE_WEIGHT[exam.score] : 1,
    });
  }
  // One number for every reader: the weighted items plus half a unit per
  // senior-year college-level course (keeping rigor up in the final year
  // is what the positioning engine always credited). The matrix and the
  // comparison block used to differ by exactly that half-unit.
  const seniorCredit = seniorCollegeLevel * SENIOR_YEAR_CREDIT;
  const units = Math.round((items.reduce((sum, item) => sum + item.weight, 0) + seniorCredit) * 100) / 100;
  return {
    units,
    apTaken: counts.ap + apExamsWithoutCourse,
    apCourses: counts.ap,
    apExamsWithoutCourse,
    apScored: items.filter((item) => item.level === "ap" && item.examScore != null).length,
    ib: counts.ib,
    dualEnrollment: counts.dual_enrollment,
    aLevel: counts.a_level,
    honors: counts.honors,
    collegeLevelCourses: counts.ap + counts.ib + counts.dual_enrollment + counts.a_level,
    seniorCollegeLevel,
    items,
  };
}

// A short English account of the load, for labels and rationales:
// "6 AP (4 with exam scores), 1 IB, 2 dual enrollment".
export function describeCourseRigor(rigor) {
  const parts = [];
  if (rigor.apTaken) parts.push(`${rigor.apTaken} AP${rigor.apScored ? ` (${rigor.apScored} with exam scores)` : ""}`);
  if (rigor.ib) parts.push(`${rigor.ib} IB`);
  if (rigor.dualEnrollment) parts.push(`${rigor.dualEnrollment} dual enrollment`);
  if (rigor.aLevel) parts.push(`${rigor.aLevel} A-Level`);
  if (rigor.honors) parts.push(`${rigor.honors} honors`);
  return parts.join(", ");
}
