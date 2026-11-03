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
// for entry in fall Y+1. January stays on the closing cycle because regular
// decision deadlines are still running then; from February every date of
// that cycle is past, so the next fall's are the ones to outline. Deadlines,
// the scout's readings and the research cache all follow it.
//
// The cycle in progress rolls over on Aug 1 (Feb 2027 is still "2026-27":
// decisions and deposits of that cycle are under way). It is a label only,
// kept where a test pins it on purpose (college-research's
// currentAdmissionsCycle); no date is resolved with it.
//
// The frontend twin is frontend/src/profile/admissions-cycle.js, held equal
// by tests/deadlines-admissions-cycle.test.js.

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

// A month/day read from a school's page, placed in the planning cycle. A
// stated year is kept as stated; either way a date outside the planning
// cycle is not this cycle's deadline and resolves to null ("November 1,
// 2026" read in March 2027 is last cycle's).
export function resolveCycleDate(month, day, year, now = new Date()) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const startYear = planningCycleStartYear(now);
  const iso = year ? `${year}-${pad(month)}-${pad(day)}` : cycleDate(startYear, month, day);
  if (!isRealDate(iso)) return null;
  const { from, to } = cycleWindow(startYear);
  return iso >= from && iso <= to ? iso : null;
}

// The cycle a student applies in, from their high-school class year: the
// class of 2028 applies in fall 2027 (cycle 2027-28). A student whose year
// has passed (or is unknown) plans for the current planning cycle, so no
// cycle is ever behind it.
export function applicationCycleStartYear(classOf, now = new Date()) {
  const planning = planningCycleStartYear(now);
  const own = Number(classOf);
  return Number.isInteger(own) && own - 1 > planning ? own - 1 : planning;
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
