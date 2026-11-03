// The client twin of backend/shared/admissions-cycle.js (the reasons live
// there), held equal by backend/tests/deadlines-admissions-cycle.test.js.
// The client cannot import backend code, and the copy it had
// (chat-orchestrator's clientTypicalISO) only "mirrored" the server by
// comment while the scout used a different pivot.
//
// The planning cycle is the one a student plans for: from Feb 1 of year Y
// through Jan 31 of Y+1 it is "Y-(Y+1)", applications in fall Y for entry
// in fall Y+1.

const FEB = 1; // 0-indexed month

export function cycleLabel(startYear) {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

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

function pad(n) { return String(n).padStart(2, "0"); }

function isRealDate(iso) {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso;
}

// August to December fall in the start year, January to July in the entry year.
export function cycleDate(startYear, month, day) {
  return `${month >= 8 ? startYear : startYear + 1}-${pad(month)}-${pad(day)}`;
}

export function cycleOfDate(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(String(iso ?? ""));
  if (!m) return null;
  const year = Number(m[1]);
  return cycleLabel(Number(m[2]) >= 8 ? year : year - 1);
}

// Today in the last zone on Earth (UTC-12), the date the server counts a
// date-only deadline from (backend/shared/calendar-date.js).
function anywhereOnEarthToday(now) {
  return new Date(now.getTime() - 12 * 3_600_000).toISOString().slice(0, 10);
}

// The cycle the planning cycle replaced on Feb 1, while it still has a day
// left (to Jul 31): its deposit and late regular deadlines are still ahead.
export function closingCycleStartYear(now = new Date()) {
  const start = planningCycleStartYear(now) - 1;
  return anywhereOnEarthToday(now) <= `${start + 1}-07-31` ? start : null;
}

// The cycle a student applies in, from their class year: the class of 2028
// applies in fall 2027. A senior keeps their own cycle while it is closing;
// anyone else plans for the planning cycle or a later one.
export function applicationCycleStartYear(classOf, now = new Date()) {
  const planning = planningCycleStartYear(now);
  const own = Number(classOf);
  if (!Number.isInteger(own)) return planning;
  if (own - 1 > planning) return own - 1;
  return own - 1 === closingCycleStartYear(now) ? own - 1 : planning;
}

// Where a school's published date lands in the student's own cycle: itself
// when it is of that cycle, carried forward (approximate) from an earlier
// one, nothing from a later one. Each date names its own cycle: a February
// reading holds next fall's Early Action beside this winter's Regular
// Decision.
export function dateForOwnCycle(iso, ownStartYear) {
  const from = cycleStartYearOf(cycleOfDate(iso));
  if (from == null || !Number.isInteger(ownStartYear) || from > ownStartYear || !isRealDate(String(iso).slice(0, 10))) return null;
  if (from === ownStartYear) return { date: String(iso).slice(0, 10), kind: "school", fromStartYear: from };
  const date = shiftDateToCycle(iso, from, ownStartYear);
  return date ? { date, kind: "carried", fromStartYear: from } : null;
}

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

// A school's date carried to a later cycle on the same month and day.
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

// The typical dates of the planning cycle (or of `startYear`), with the
// entry year: what chat-orchestrator's clientTypicalISO returned, so it can
// become a re-export of this.
export function clientTypicalISO(now = new Date(), startYear = null) {
  const start = Number.isInteger(startYear) ? startYear : planningCycleStartYear(now);
  return { ...typicalDeadlineDates(start), cycleEntryYear: start + 1 };
}
