// What the server holds a deadline to (backend/shared/deadline-rules.js):
// the form says it up front, and backend/tests/deadlines-limits-parity.test.js
// fails when the two sides drift, so a raised server cap is never cut short
// by the form's maxLength (or a lowered one 400s what the form allowed).
export const DEADLINE_TITLE_MAX = 200;
export const DEADLINE_EARLIEST_DATE = "2000-01-01";
export const DEADLINE_YEARS_AHEAD = 6;
export const DEADLINE_CATEGORIES = ["personal", "admissions", "financial_aid", "test", "other"];

// The latest date the form offers: six years from today (UTC, as the server
// counts it).
export function latestDeadlineDate(now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + DEADLINE_YEARS_AHEAD);
  return d.toISOString().slice(0, 10);
}
