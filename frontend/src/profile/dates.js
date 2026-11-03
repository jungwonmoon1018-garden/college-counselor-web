// SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" (UTC, no zone). Safari
// refuses to parse that shape (Invalid Date) while Chrome parses it as LOCAL
// time — so thread timestamps were blank on iOS and shifted by the timezone
// offset elsewhere. Normalize to strict ISO-8601 UTC before Date sees it.
// Every server timestamp the UI shows goes through parseServerDate; the
// story editor's "Saved …" read the raw value and showed 05:00 for a 14:00
// KST save (and "Invalid Date" on an iPhone).
export function serverDateToISO(value) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(String(value || ""));
  return m ? `${m[1]}T${m[2]}Z` : String(value || "");
}

// A Date for a server timestamp, or null when it does not parse.
export function parseServerDate(value) {
  if (value == null || value === "") return null;
  const d = new Date(serverDateToISO(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatServerDate(value) {
  const d = parseServerDate(value);
  return d ? d.toLocaleDateString() : "";
}

// Date and time in the viewer's own zone.
export function formatServerDateTime(value, locale) {
  const d = parseServerDate(value);
  return d ? d.toLocaleString(locale) : "";
}

// ── Deadline dates ─────────────────────────────────────────────────────
// A deadline is a calendar date, not an instant. The tracker used to send
// new Date("2027-01-01").toISOString(), i.e. UTC midnight, so a student in
// California saw "Dec 31" for the date she typed, and Math.round of the
// milliseconds left read "Overdue" from 07:00 on the due day in New York and
// 21:00 in Seoul. A date-only value is now shown and counted as the local
// calendar date it names. The server twin is backend/shared/calendar-date.js.
const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Rows saved before 2026-11 hold a typed date as UTC midnight.
const LEGACY_UTC_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0+)?)?(?:Z|\+00:00)$/;

function isCalendarDate(value) {
  const m = DATE_ONLY.exec(String(value ?? ""));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

// The YYYY-MM-DD a due value names, or null for a real instant.
export function calendarDateOf(value) {
  const s = String(value ?? "").trim();
  if (isCalendarDate(s)) return s;
  const legacy = LEGACY_UTC_MIDNIGHT.exec(s);
  return legacy && isCalendarDate(legacy[1]) ? legacy[1] : null;
}

function pad(n) { return String(n).padStart(2, "0"); }

// Today's date on the viewer's own calendar.
export function localDateString(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function ymdUtcMs(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

// Whole days left: for a date, local calendar days (0 all through the due
// date, -1 from the next local midnight); for a timed value, the days left
// before that instant (negative as soon as it has passed).
export function daysUntilDue(value, now = new Date()) {
  const date = calendarDateOf(value);
  if (date) return Math.round((ymdUtcMs(date) - ymdUtcMs(localDateString(now))) / DAY_MS);
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? Math.floor((ms - now.getTime()) / DAY_MS) : null;
}

// A due value for display: a date as that date in every time zone.
export function formatDueDate(value, locale) {
  const opts = { year: "numeric", month: "short", day: "numeric" };
  const date = calendarDateOf(value);
  if (date) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(locale, opts);
  }
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(locale, opts) : "";
}

// A sort key that puts a date at its own day among timed rows.
export function dueSortKey(value) {
  const date = calendarDateOf(value);
  if (date) return ymdUtcMs(date);
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}
