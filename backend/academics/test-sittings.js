// academics/test-sittings.js — which SAT or ACT sitting a reader takes when
// the profile holds more than one.
//
// The profile keeps every sitting in the order it was entered
// (normalizeTestScores), and the editors append a new one at the end, so a
// reader that took the first entry for a test always read the oldest score.
// A student who retook the SAT and went from 1250 to 1480 kept seeing 1250
// placed "below the 25th percentile" on College Fit, the same class of bug
// fixed for AP retakes in 12278ad. A reader now says which sitting it wants:
//
//   "best"   the highest total, a tie going to the later sitting. This is
//            what a student submits and what College Fit compares with a
//            school's middle 50%; colleges that superscore would go further,
//            but the highest single sitting is the safe default.
//   "latest" the most recent sitting, by its YYYY-MM date when both carry
//            one, else by its place in the list (a later entry was added
//            later). For a reader that wants the current state rather than
//            the strongest one.
//
// Sections always come from the chosen sitting, never mixed across sittings.
// Pure: no I/O, and the entries are returned as stored.

import { testKey } from "./test-catalog.js";

function totalOf(entry) {
  const n = Number(entry?.totalScore ?? entry?.total ?? entry?.score);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Months since year zero for a "YYYY-MM" (or "YYYY-MM-DD") date, or null.
function monthIndex(entry) {
  const m = /^(\d{4})-(\d{2})/.exec(String(entry?.date || ""));
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
}

// Every sitting of one test, with its place in the list, in list order.
export function testSittings(testScores, test) {
  const wanted = testKey(test);
  return (Array.isArray(testScores) ? testScores : [])
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry && typeof entry === "object" && testKey(entry.test) === wanted && totalOf(entry) != null);
}

// True when sitting a was taken after sitting b.
function laterThan(a, b) {
  const ma = monthIndex(a.entry);
  const mb = monthIndex(b.entry);
  if (ma != null && mb != null && ma !== mb) return ma > mb;
  return a.index > b.index;
}

export function chooseTestSitting(testScores, test, { mode = "best" } = {}) {
  const sittings = testSittings(testScores, test);
  if (!sittings.length) return null;
  let chosen = sittings[0];
  for (const candidate of sittings.slice(1)) {
    if (mode === "latest") {
      if (laterThan(candidate, chosen)) chosen = candidate;
      continue;
    }
    const a = totalOf(candidate.entry);
    const b = totalOf(chosen.entry);
    if (a > b || (a === b && laterThan(candidate, chosen))) chosen = candidate;
  }
  return chosen.entry;
}
