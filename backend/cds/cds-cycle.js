// cds/cds-cycle.js — Common Data Set cycles read from the data and the
// clock, never from a list of years written into the code.
//
// A Common Data Set labelled "2025-26" describes the class that entered in
// the fall of 2025; schools publish it over the following months, most of
// them by the summer of 2026 (the daily refresh runs from June for that
// reason, cds-ingest-pipeline.js). Three readers used to carry the year as
// a constant: the repository index labelled its columns from a list that
// started at "2024-25" (a new column at the front would have filed every
// document one cycle older), evidence confidence scored any record from
// 2025 on as current forever, and the College Fit double-check took College
// Scorecard's data year to be 2024 for good. Each now asks this module, with
// `now` injectable for tests.

// "2025-26", "2025-2026", "2025–26" → "2025-26"; anything else → null.
export function normalizeCycleLabel(text) {
  const m = /^\s*(20\d{2})\s*[-–/]\s*(?:20)?(\d{2})\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  const start = Number(m[1]);
  // The second half must be the next year: "2025-26", not "2025-27".
  if ((start + 1) % 100 !== Number(m[2])) return null;
  return `${start}-${m[2]}`;
}

// The first cycle named anywhere in a short text ("CDS 2025-26", "2025-2026
// data"), normalized, or null.
export function findCycleLabel(text) {
  for (const m of String(text ?? "").matchAll(/(?<!\d)(20\d{2})\s*[-–/]\s*((?:20)?\d{2})(?!\d)/g)) {
    const label = normalizeCycleLabel(`${m[1]}-${m[2]}`);
    if (label) return label;
  }
  return null;
}

// The year a cycle starts in, from a label ("2025-26"), a bare year (2025,
// "2025"), or a date-like string. Null when nothing reads as a year.
export function cycleStartYear(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isInteger(value) && value >= 1990 && value <= 2200 ? value : null;
  const m = /(?:^|\D)((?:19|20|21)\d{2})(?!\d)/.exec(String(value));
  return m ? Number(m[1]) : null;
}

const PUBLISHED_BY_MONTH = 5; // 0-indexed: June

// The newest cycle most schools have published by `now`: from June 2026
// that is 2025-26, and before June it was 2024-25.
export function newestCdsCycleStart(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const year = date.getUTCFullYear();
  return date.getUTCMonth() >= PUBLISHED_BY_MONTH ? year - 1 : year - 2;
}

// How many cycles a record trails the newest one by (0 or more; a record
// newer than the newest counts as current), or null when it carries no year.
export function cycleAge(value, now = new Date()) {
  const start = cycleStartYear(value);
  if (start == null) return null;
  return Math.max(0, newestCdsCycleStart(now) - start);
}

// The data year of College Scorecard's "latest" admissions block, which
// trails the newest Common Data Set by about a cycle: in November 2026 its
// latest figures describe the class that entered in fall 2024, the year the
// double-check used to hard-code.
export function scorecardDataYear(now = new Date()) {
  return newestCdsCycleStart(now) - 1;
}
