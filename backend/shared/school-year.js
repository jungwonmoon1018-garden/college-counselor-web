// shared/school-year.js — the US school year a date falls in, and a
// student's grade from the class (graduation year) they belong to.
//
// The grade used to be a number typed once at registration and never
// moved: a junior who signed up in October 2026 was still a junior through
// the 2027 application season, billed against the junior cap when the
// senior one exists for exactly those months. The account now stores its
// class (class_of) and the grade is read from today's date. The school year
// starts on August 1 (UTC), the boundary rag-engine's academic year and the
// deadline cull already use; a graduated account reads as grade 12, so it
// keeps the senior cap and the senior-year defaults rather than falling off
// the 9-12 scale every budget and prompt expects.

const SCHOOL_YEAR_START_MONTH = 7; // 0-indexed: August

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

// The calendar year the school year containing `now` began in: 2026 for any
// date from 2026-08-01 through 2027-07-31.
export function schoolYearStart(now = new Date()) {
  const date = toDate(now);
  const year = date.getUTCFullYear();
  return date.getUTCMonth() >= SCHOOL_YEAR_START_MONTH ? year : year - 1;
}

// The graduation year of a student in `grade` (9-12) on `now`: a junior in
// the 2026-27 school year is the class of 2028.
export function classOfForGrade(grade, now = new Date()) {
  const number = Number(grade);
  if (![9, 10, 11, 12].includes(number)) return null;
  return schoolYearStart(now) + 1 + (12 - number);
}

// The grade a class is in on `now`, held to 9-12: an account whose class has
// graduated stays 12, and a class not yet in high school reads as 9.
export function gradeForClassOf(classOf, now = new Date()) {
  const year = Number(classOf);
  if (!Number.isInteger(year)) return null;
  const grade = 12 - (year - (schoolYearStart(now) + 1));
  return Math.min(12, Math.max(9, grade));
}
