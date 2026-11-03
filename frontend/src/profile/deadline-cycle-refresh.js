// Which target schools need their reminders made again for the student's own
// admissions cycle (input-8). A school's reminders are created once, when it
// is added to the target list, so rows made for an earlier cycle (every row
// made before 2026-11 carried the senior cycle's dates whatever the grade, and
// a student whose class year is unknown plans in a cycle that rolls over each
// Feb 1) stayed the only ones, and the dates of the cycle the student applies
// in never appeared. On entering the chat the app asks this for the schools
// whose reminders all belong to an earlier cycle, and makes theirs again
// (handlers/school-handlers.js createDeadlinesForSchool). The bulk route
// de-duplicates within a cycle, so the old rows stay as they were.
import { cycleOfDate, cycleStartYearOf } from "./admissions-cycle.js";
import { calendarDateOf } from "./dates.js";

// The reminders createDeadlinesForSchool makes are titled "<school> — <round>".
function rowsForSchool(rows, school) {
  const prefix = `${school} — `.toLowerCase();
  return rows.filter((row) => String(row?.title || "").toLowerCase().startsWith(prefix));
}

// A row's cycle is the one its date falls in, as the bulk route reads it.
function rowCycleStart(row) {
  const date = calendarDateOf(row?.dueDate) || calendarDateOf(row?.dueAt) || String(row?.dueAt || "").slice(0, 10);
  return cycleStartYearOf(cycleOfDate(date));
}

// `studentCycle` is the calendar route's { startYear, classOf }. A school with
// no reminders at all is left alone: the student may have removed them, and
// making them again every session would undo that.
export function schoolsDueForNewCycle({ targetSchools, deadlines, studentCycle } = {}) {
  const own = studentCycle?.startYear;
  if (!Number.isInteger(own)) return [];
  // A known class year whose own cycle is over (a senior from Aug 1 on) has
  // had it: the server then plans in the next one, and next year's reminders
  // would be noise for a student who has applied. Until Jul 31 a senior
  // stays in their own, closing cycle (applicationCycleStartYear), so their
  // reminders are made for it and this check does not fire.
  const classOf = Number(studentCycle?.classOf);
  if (Number.isInteger(classOf) && classOf > 0 && classOf - 1 < own) return [];
  const rows = Array.isArray(deadlines) ? deadlines : [];
  const due = [];
  for (const school of Array.isArray(targetSchools) ? targetSchools : []) {
    const name = String(school || "").trim();
    if (!name) continue;
    const starts = rowsForSchool(rows, name).map(rowCycleStart).filter(Number.isInteger);
    if (starts.length && Math.max(...starts) < own) due.push(name);
  }
  return due;
}
