// shared/deadline-rules.js — a deadline's name and date are held to the
// same rules on create, bulk create and edit (routes/students.js). The name
// is what the list, the reminders and the chat show, and had no cap; 200
// characters is a long sentence. A date before 2000 or more than six years
// out is a typing slip (a ninth grader's furthest real deadline is about
// four years away): a year typed as 0202 or 20266 was stored as given and
// sorted to the ends of the list. The tracker's form carries a copy of these
// (frontend/src/profile/deadline-limits.js), held equal by
// tests/deadlines-limits-parity.test.js.
export const DEADLINE_TITLE_MAX = 200;
export const DEADLINE_CATEGORIES = ["personal", "admissions", "financial_aid", "test", "other"];
export const DEADLINE_EARLIEST_MS = Date.UTC(2000, 0, 1);
export const DEADLINE_YEARS_AHEAD = 6;

// The allowed window ({ from, to } as dates) when `ms` falls outside it.
export function deadlineDateOutside(ms, now = Date.now()) {
  const latest = new Date(now);
  latest.setUTCFullYear(latest.getUTCFullYear() + DEADLINE_YEARS_AHEAD);
  if (ms >= DEADLINE_EARLIEST_MS && ms <= latest.getTime()) return null;
  return { from: new Date(DEADLINE_EARLIEST_MS).toISOString().slice(0, 10), to: latest.toISOString().slice(0, 10) };
}
