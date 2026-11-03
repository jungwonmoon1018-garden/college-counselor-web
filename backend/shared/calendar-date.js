// shared/calendar-date.js — a deadline the student types, or one a school
// publishes, is a calendar date ("Jan 1"), not an instant. The tracker used
// to send new Date("2027-01-01").toISOString(), which is UTC midnight: a
// student in New York saw the date she typed as Dec 31, and the server's
// Math.round of milliseconds counted the row overdue from 12:00 UTC on the
// due day itself (9 PM in Seoul, about 17 hours before an 11:59 PM Eastern
// deadline closes) and, before Aug 1, hid it. A date-only deadline is now
// stored as YYYY-MM-DD and counted in whole calendar days. The server does
// not know the student's time zone, so unless the client names its own
// local date it counts from the date in the last zone on Earth (UTC-12,
// "Anywhere on Earth"): a deadline is overdue only once its date has ended
// everywhere, and an error can only land late by a few hours, never early.
// The frontend twin is frontend/src/profile/dates.js.

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Rows written before 2026-11 hold a typed date as UTC midnight; any
// spelling of that instant is read back as the date the student typed.
const LEGACY_UTC_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0+)?)?(?:Z|\+00:00)$/;
const EARLIEST_ZONE_HOURS = -12; // Baker Island: the last place a date ends
const LATEST_ZONE_HOURS = 14;    // Kiribati: the first place a date begins

// True for a real calendar date written YYYY-MM-DD (2027-02-30 is not).
export function isCalendarDate(value) {
  const m = DATE_ONLY.exec(String(value ?? ""));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

// The calendar date a stored or submitted due value names, or null when the
// value is a real instant (a time of day other than UTC midnight).
export function calendarDateOf(value) {
  const s = String(value ?? "").trim();
  if (isCalendarDate(s)) return s;
  const legacy = LEGACY_UTC_MIDNIGHT.exec(s);
  return legacy && isCalendarDate(legacy[1]) ? legacy[1] : null;
}

export function calendarDateToUtcMs(ymd) {
  const m = DATE_ONLY.exec(String(ymd ?? ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

// Whole calendar days from one date to another (negative when `to` is past).
export function calendarDaysBetween(fromYmd, toYmd) {
  return Math.round((calendarDateToUtcMs(toYmd) - calendarDateToUtcMs(fromYmd)) / DAY_MS);
}

export function addCalendarDays(ymd, days) {
  return new Date(calendarDateToUtcMs(ymd) + days * DAY_MS).toISOString().slice(0, 10);
}

function dateAtOffset(nowMs, hours) {
  return new Date(nowMs + hours * 3_600_000).toISOString().slice(0, 10);
}

// Today's date in the last zone on Earth: a date-only deadline is overdue on
// the server only once this has passed it.
export function anywhereOnEarthToday(nowMs = Date.now()) {
  return dateAtOffset(nowMs, EARLIEST_ZONE_HOURS);
}

// The date to count from: the client's own local date when it sends one and
// that date is today somewhere on Earth, otherwise Anywhere-on-Earth today.
// A claimed date outside that window is a wrong clock, not a time zone.
export function referenceToday(claimed, nowMs = Date.now()) {
  const earliest = anywhereOnEarthToday(nowMs);
  if (isCalendarDate(claimed)) {
    const latest = dateAtOffset(nowMs, LATEST_ZONE_HOURS);
    if (claimed >= earliest && claimed <= latest) return claimed;
  }
  return earliest;
}

// Days until a due value: calendar days for a date-only value (0 on the due
// date, negative once it has passed), and for a timed value the whole days
// left before that instant (negative as soon as it has passed).
export function daysUntilDue(dueValue, { nowMs = Date.now(), today = null } = {}) {
  const dueDate = calendarDateOf(dueValue);
  if (dueDate) return calendarDaysBetween(referenceToday(today, nowMs), dueDate);
  const ms = Date.parse(String(dueValue ?? ""));
  return Number.isFinite(ms) ? Math.floor((ms - nowMs) / DAY_MS) : null;
}

// What to store for a submitted due value: YYYY-MM-DD for a date (including
// a UTC-midnight instant an older client sent for one), ISO-8601 for a real
// instant, null when it does not parse.
export function normalizeDueValue(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = calendarDateOf(value);
  if (date) return date;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Milliseconds for range checks: a date counts as its UTC midnight.
export function dueValueMs(stored) {
  const date = calendarDateOf(stored);
  return date ? calendarDateToUtcMs(date) : Date.parse(String(stored ?? ""));
}

// SQLite's datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC with no zone.
// Sent raw, Chrome reads it as local time and Safari as Invalid Date (the
// story editor's "Saved …" was 9 hours off in Seoul and blank on an
// iPhone); a route returns it as ISO-8601 with the Z.
export function sqliteUtcToIso(value) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(String(value ?? ""));
  return m ? `${m[1]}T${m[2]}Z` : value ?? null;
}
