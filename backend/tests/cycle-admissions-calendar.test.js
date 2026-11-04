// The admissions calendar the chat's date preamble prints. From Feb 1 it
// outlines next fall's (planning) cycle, but the cycle it replaced is still
// closing until Jul 31: a senior asking in February was given an enrollment
// deposit of May 1 of the following year. Every clock here is fixed.
import test from "node:test";
import assert from "node:assert/strict";
import { buildAdmissionsCalendar } from "../server/narrative-calendar.js";
import { typicalDeadlineDates } from "../shared/admissions-cycle.js";

test("from Feb 1 the calendar carries the closing cycle and its deposit beside the planning cycle", () => {
  const cal = buildAdmissionsCalendar(new Date("2027-02-03T17:00:00Z"));
  // The planning cycle is unchanged (deadlines-admissions-cycle.test.js pins it).
  assert.equal(cal.cycleStartYear, 2027);
  assert.deepEqual(cal.typicalISO, typicalDeadlineDates(2027));
  assert.equal(cal.typicalDeadlines.nationalDepositDeadline, "May 1 2028");
  assert.deepEqual(cal.closingCycle, {
    cycle: "2026-27",
    cycleStartYear: 2026,
    cycleEntryYear: 2027,
    applicationCycle: "Class entering Fall 2027",
    rdDecisionsRelease: "mid-Mar–early-Apr 2027",
    nationalDepositDeadline: "May 1 2027",
    depositISO: "2027-05-01",
    depositPassed: false,
    note: cal.closingCycle?.note,
  });
  assert.match(cal.closingCycle.note, /seniors/i);
  assert.match(cal.phase, /^planning the upcoming cycle/);
  assert.match(cal.phase, /the 2026-27 cycle is closing — late regular deadlines, decisions and the May 1 2027 enrollment deposit are still ahead/);
});

test("the deposit is ahead through May 1 Anywhere on Earth, and passed after it", () => {
  // 11:00 UTC on May 2 is still May 1 at UTC-12.
  assert.equal(buildAdmissionsCalendar(new Date("2027-05-02T11:00:00Z")).closingCycle.depositPassed, false);
  const june = buildAdmissionsCalendar(new Date("2027-06-15T12:00:00Z"));
  assert.equal(june.closingCycle.depositPassed, true);
  assert.match(june.phase, /the 2026-27 cycle is closing — its May 1 2027 enrollment deposit date has passed/);
  assert.doesNotMatch(june.phase, /still ahead/);
});

test("the closing cycle is named from Feb 1 to Jul 31 and nowhere else", () => {
  for (const iso of ["2027-01-31T12:00:00Z", "2027-08-02T12:00:00Z", "2026-11-03T12:00:00Z", "2026-12-31T23:00:00Z"]) {
    const cal = buildAdmissionsCalendar(new Date(iso));
    assert.equal("closingCycle" in cal, false, iso);
    assert.doesNotMatch(cal.phase, /closing/, iso);
  }
  assert.equal(buildAdmissionsCalendar(new Date("2027-02-01T00:30:00Z")).closingCycle?.cycle, "2026-27");
  // Jul 31 is the cycle's last day; at 10:00 UTC on Aug 1 it still is at UTC-12.
  assert.equal(buildAdmissionsCalendar(new Date("2027-07-31T20:00:00Z")).closingCycle?.cycle, "2026-27");
  assert.equal(buildAdmissionsCalendar(new Date("2027-08-01T10:00:00Z")).closingCycle?.cycle, "2026-27");
});
