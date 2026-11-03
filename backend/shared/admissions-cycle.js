// shared/admissions-cycle.js — which application cycle a date belongs to.
//
// Two pivots were written out by hand in five places and disagreed: the
// scout and the deadline research rolled over on Aug 1, the calendar, the
// Common Data Set roll-forward and the client on Feb 1. From February to
// July the scout resolved a yearless "Early Decision: November 1" into the
// cycle that had just closed (a reminder created in March was already past,
// hidden until August and then shown as missed), and from April its
// 150-day floor dropped the date altogether, while the calendar block sent
// to the model in the same turn showed next fall's dates.
//
// There are two notions, and each caller names the one it means:
//
// The planning cycle is the one a student plans for. From Feb 1 of year Y
// through Jan 31 of Y+1 it is "Y-(Y+1)": applications go in during fall Y
// for entry in fall Y+1. January stays on the closing cycle because most
// regular decision deadlines are still running then, and from February the
// next fall's dates are the ones to outline. Deadlines, the scout's
// readings and the research cache all follow it.
//
// The closing cycle is the one the planning cycle replaced on Feb 1. It is
// not over then: a Feb 15 or Mar 1 regular deadline, the spring aid-priority
// dates and the May 1 deposit are still ahead, and a senior is still in it.
// The first version of this rule assumed every date of that cycle was past
// in February, so a page read on Feb 3 lost its "February 15, 2027" and a
// yearless "February 15" became 2028-02-15, given to a senior as the
// school's deadline. A date of the closing cycle is kept until it has ended
// Anywhere on Earth (shared/calendar-date.js), and the cycle runs to Jul 31.
//
// The cycle in progress rolls over on Aug 1 (Feb 2027 is still "2026-27":
// decisions and deposits of that cycle are under way). It is a label only,
// kept where a test pins it on purpose (college-research's
// currentAdmissionsCycle); no date is resolved with it.
//
// The frontend twin is frontend/src/profile/admissions-cycle.js, held equal
// by tests/deadlines-admissions-cycle.test.js.

import { anywhereOnEarthToday } from "./calendar-date.js";

const FEB = 1; // 0-indexed months, as getUTCMonth returns them
const AUG = 7;

export function cycleLabel(startYear) {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// The start year a "YYYY-YY" label names, or null.
export function cycleStartYearOf(label) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(label ?? ""));
  if (!m) return null;
  const start = Number(m[1]);
  return (start + 1) % 100 === Number(m[2]) ? start : null;
}

export function planningCycleStartYear(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= FEB ? y : y - 1;
}

export function planningCycle(now = new Date()) {
  return cycleLabel(planningCycleStartYear(now));
}

export function cycleInProgressStartYear(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= AUG ? y : y - 1;
}

export function cycleInProgress(now = new Date()) {
  return cycleLabel(cycleInProgressStartYear(now));
}

function pad(n) { return String(n).padStart(2, "0"); }

// A month and day placed in the cycle that starts in `startYear`: August to
// December fall in the start year (the fall applications go in), January to
// July in the entry year.
export function cycleDate(startYear, month, day) {
  return `${month >= 8 ? startYear : startYear + 1}-${pad(month)}-${pad(day)}`;
}

// The cycle a dated deadline belongs to ("2027-11-01" and "2028-01-05" are
// both 2027-28).
export function cycleOfDate(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(String(iso ?? ""));
  if (!m) return null;
  const year = Number(m[1]);
  return cycleLabel(Number(m[2]) >= 8 ? year : year - 1);
}

// The first and last day a deadline of a cycle can fall on.
export function cycleWindow(startYear) {
  return { from: `${startYear}-08-01`, to: `${startYear + 1}-07-31` };
}

function isRealDate(iso) {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso;
}

function inCycle(iso, startYear) {
  const { from, to } = cycleWindow(startYear);
  return iso >= from && iso <= to;
}

// The start year of the closing cycle while it still has a day left (Feb 1
// to Jul 31, counted Anywhere on Earth), else null.
export function closingCycleStartYear(now = new Date()) {
  const start = planningCycleStartYear(now) - 1;
  return anywhereOnEarthToday(now.getTime()) <= cycleWindow(start).to ? start : null;
}

// A month/day read from a school's page, placed in the planning cycle, or in
// the closing cycle while that date is still ahead ("February 15" read on
// Feb 3 is this month's deadline, not one a year away). A stated year is
// kept as stated. A date of neither is not a deadline anyone can still meet
// and resolves to null ("November 1, 2026" read in March 2027 is last
// cycle's and past).
export function resolveCycleDate(month, day, year, now = new Date()) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const startYear = planningCycleStartYear(now);
  const closing = closingCycleStartYear(now);
  const today = anywhereOnEarthToday(now.getTime());
  const stillOpen = (iso) => closing != null && isRealDate(iso) && inCycle(iso, closing) && iso >= today;
  if (year) {
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    if (!isRealDate(iso)) return null;
    return inCycle(iso, startYear) || stillOpen(iso) ? iso : null;
  }
  if (closing != null) {
    const iso = cycleDate(closing, month, day);
    if (stillOpen(iso)) return iso;
  }
  const iso = cycleDate(startYear, month, day);
  return isRealDate(iso) ? iso : null;
}

// The cycle a student applies in, from their high-school class year: the
// class of 2028 applies in fall 2027 (cycle 2027-28). A senior stays in
// their own cycle while it is closing (to Jul 31), so the deposit and any
// late regular deadline are dated for the year they enter, not the next.
// A student whose year has passed (or is unknown) plans for the current
// planning cycle.
export function applicationCycleStartYear(classOf, now = new Date()) {
  const planning = planningCycleStartYear(now);
  const own = Number(classOf);
  if (!Number.isInteger(own)) return planning;
  if (own - 1 > planning) return own - 1;
  return own - 1 === closingCycleStartYear(now) ? own - 1 : planning;
}

// Where a school's published date lands in a student's own cycle: the date
// itself when it is of that cycle, carried forward on the same month and day
// (approximate) when it is of an earlier one, and nothing when it is of a
// later one. A date names its own cycle (cycleOfDate). A reading taken in
// February holds next fall's Early Action beside the closing cycle's
// February 15 Regular Decision, and one cycle label for the whole reading
// put one of them in the wrong year.
export function dateForOwnCycle(iso, ownStartYear) {
  const from = cycleStartYearOf(cycleOfDate(iso));
  if (from == null || !Number.isInteger(ownStartYear) || from > ownStartYear || !isRealDate(String(iso).slice(0, 10))) return null;
  if (from === ownStartYear) return { date: String(iso).slice(0, 10), kind: "school", fromStartYear: from };
  const date = shiftDateToCycle(iso, from, ownStartYear);
  return date ? { date, kind: "carried", fromStartYear: from } : null;
}

// The typical US dates of a cycle: a planning window, never a school's
// deadline. Callers label them "approximate".
export function typicalDeadlineDates(startYear) {
  const entry = startYear + 1;
  return {
    earlyEaEd: `${startYear}-11-01`,
    regularDecision: `${entry}-01-01`,
    financialAidPriority: `${entry}-02-01`,
    fafsaOpens: `${startYear}-10-01`,
    nationalDepositDeadline: `${entry}-05-01`,
  };
}

// A school's date for one cycle carried to a later cycle on the same month
// and day (Feb 29 becomes Feb 28 in a common year): the CDS roll-forward's
// assumption, used when a student's own cycle is after the one the school
// has published. The result is approximate and is labeled so.
export function shiftDateToCycle(iso, fromStartYear, toStartYear) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m || !Number.isInteger(fromStartYear) || !Number.isInteger(toStartYear)) return null;
  const year = Number(m[1]) + (toStartYear - fromStartYear);
  let day = Number(m[3]);
  const month = Number(m[2]);
  if (month === 2 && day === 29 && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) day = 28;
  const out = `${year}-${pad(month)}-${pad(day)}`;
  return isRealDate(out) ? out : null;
}
