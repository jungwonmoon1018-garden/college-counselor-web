// One admissions-cycle rule for every deadline path. The scout and the
// deadline research rolled over on Aug 1 while the calendar, the Common Data
// Set roll-forward and the client rolled over on Feb 1, so from February a
// yearless "Early Decision: November 1" was read as last fall's date and
// from April it was dropped. Every clock here is fixed; no case depends on
// the day the suite runs.
import test from "node:test";
import assert from "node:assert/strict";
import * as server from "../shared/admissions-cycle.js";
import * as client from "../../frontend/src/profile/admissions-cycle.js";
import { currentAdmissionsCycle } from "../colleges/college-research.js";
import { cdsDeadlinesForCycle } from "../cds/cds-store.js";
import { buildAdmissionsCalendar } from "../server/narrative-calendar.js";
import { SCOUT_VERSION, extractPolicyFromPages, formatPolicyLine, resolveCycleDate, snapshotAsDeadlineRecord, snapshotIsCurrent } from "../scouts/admissions-policy-scout.js";

const at = (iso) => new Date(iso);

// [clock, planning cycle, cycle in progress]
const TABLE = [
  ["2027-01-15T12:00:00Z", "2026-27", "2026-27"],
  ["2027-01-31T23:59:00Z", "2026-27", "2026-27"],
  ["2027-02-01T00:00:00Z", "2027-28", "2026-27"],
  ["2027-02-15T12:00:00Z", "2027-28", "2026-27"],
  ["2027-03-10T12:00:00Z", "2027-28", "2026-27"],
  ["2027-04-15T12:00:00Z", "2027-28", "2026-27"],
  ["2027-06-15T12:00:00Z", "2027-28", "2026-27"],
  ["2027-07-31T23:59:00Z", "2027-28", "2026-27"],
  ["2027-08-01T00:00:00Z", "2027-28", "2027-28"],
  ["2027-11-03T12:00:00Z", "2027-28", "2027-28"],
  ["2027-12-31T23:59:00Z", "2027-28", "2027-28"],
];

const CDS_RECORD = {
  school: "Example University", yearLabel: "2025-26",
  extras: { dates: { edClosing: { mmdd: "11-01" }, regularClosing: { mmdd: "01-05" } } },
};

const page = (text) => [{ url: "https://admissions.example.edu/apply", text }];

test("every deadline path names the same planning cycle in every month", () => {
  for (const [clock, planning, inProgress] of TABLE) {
    const now = at(clock);
    const start = Number(planning.slice(0, 4));
    assert.equal(server.planningCycle(now), planning, clock);
    assert.equal(client.planningCycle(now), planning, clock);
    // The Aug-1 label is kept where it is pinned, and only there.
    assert.equal(currentAdmissionsCycle(now), inProgress, clock);
    assert.equal(server.cycleInProgress(now), inProgress, clock);
    assert.equal(buildAdmissionsCalendar(now).cycleStartYear, start, clock);
    assert.deepEqual(buildAdmissionsCalendar(now).typicalISO, server.typicalDeadlineDates(start), clock);
    assert.equal(cdsDeadlinesForCycle(CDS_RECORD, now).cycle, planning, clock);
    assert.equal(extractPolicyFromPages(page("Our campus has a lake."), now).cycle, planning, clock);
    // A yearless date always lands in the planning cycle; it used to be
    // last fall's in February and March and null from April to July.
    assert.equal(resolveCycleDate(11, 1, null, now), `${start}-11-01`, clock);
    assert.equal(resolveCycleDate(1, 5, null, now), `${start + 1}-01-05`, clock);
    assert.deepEqual(client.clientTypicalISO(now), { ...buildAdmissionsCalendar(now).typicalISO, cycleEntryYear: start + 1 }, clock);
  }
});

test("a page read in March places a yearless date in the coming fall and drops last cycle's", () => {
  const march = at("2027-03-01T12:00:00Z");
  const yearless = extractPolicyFromPages(page("Early Decision deadline: November 1"), march);
  assert.equal(yearless.deadlines.early_decision?.date, "2027-11-01");
  const stated = extractPolicyFromPages(page("Early Decision deadline: November 1, 2026"), march);
  assert.equal(stated.deadlines.early_decision, undefined, "last cycle's date is not this cycle's deadline");
  const april = extractPolicyFromPages(page("Early Action deadline: November 1"), at("2027-04-20T12:00:00Z"));
  assert.equal(april.deadlines.early_action?.date, "2027-11-01", "kept, not dropped by a 150-day floor");
});

// From Feb 1 the planning cycle is next fall's, but the cycle that is closing
// still has dates ahead: a Feb 15 or Mar 1 regular deadline, the May 1
// deposit. The first planning-cycle rule threw a stated "February 15, 2027"
// away on Feb 3 and read a yearless "February 15" as 2028-02-15, which the
// dates answer then gave a senior as the school's deadline. A date of the
// closing cycle is kept until it has ended Anywhere on Earth.
const CLOSING_CLOCKS = {
  feb1: at("2027-02-01T15:00:00Z"),
  mar15: at("2027-03-15T12:00:00Z"),
  jul31: at("2027-07-31T12:00:00Z"),
};

test("the closing cycle's open deadlines are kept after Feb 1 and dropped once they pass", () => {
  const { feb1, mar15, jul31 } = CLOSING_CLOCKS;
  // [month, day, stated year, clock, expected]
  const cases = [
    [2, 1, 2027, feb1, "2027-02-01"], // the deadline day itself
    [2, 1, null, feb1, "2027-02-01"],
    [2, 15, 2027, feb1, "2027-02-15"],
    [2, 15, null, feb1, "2027-02-15"],
    [3, 1, null, feb1, "2027-03-01"],
    [5, 1, null, feb1, "2027-05-01"],
    [11, 1, 2026, feb1, null], // last fall's, past
    [11, 1, null, feb1, "2027-11-01"],
    [1, 5, null, feb1, "2028-01-05"], // January is over: next cycle's
    [2, 15, 2027, mar15, null],
    [2, 15, null, mar15, "2028-02-15"],
    [3, 1, null, mar15, "2028-03-01"],
    [3, 15, 2027, mar15, "2027-03-15"],
    [5, 1, null, mar15, "2027-05-01"],
    [5, 1, 2027, mar15, "2027-05-01"],
    [5, 1, null, jul31, "2028-05-01"],
    [5, 1, 2027, jul31, null],
    [7, 31, null, jul31, "2027-07-31"],
    [7, 31, 2027, jul31, "2027-07-31"],
    [11, 1, null, jul31, "2027-11-01"],
    [11, 1, 2027, jul31, "2027-11-01"],
  ];
  for (const [month, day, year, clock, expected] of cases) {
    assert.equal(resolveCycleDate(month, day, year, clock), expected, `${month}/${day}/${year ?? "-"} read ${clock.toISOString()}`);
  }
  // Ended Anywhere on Earth: still Feb 1 at UTC-12 until 12:00 UTC on Feb 2.
  assert.equal(resolveCycleDate(2, 1, 2027, at("2027-02-02T11:00:00Z")), "2027-02-01");
  assert.equal(resolveCycleDate(2, 1, 2027, at("2027-02-02T12:00:00Z")), null);
  // Before Feb 1 nothing of the cycle before the planning one is open.
  assert.equal(resolveCycleDate(5, 1, 2026, at("2027-01-15T12:00:00Z")), null);
});

test("a February read keeps a senior's open Regular Decision date and labels it by its own cycle", () => {
  const feb3 = at("2027-02-03T12:00:00Z");
  const stated = extractPolicyFromPages(page("Early Action: November 1, 2026\nRegular Decision: February 15, 2027"), feb3);
  assert.equal(stated.cycle, "2027-28");
  assert.equal(stated.deadlines.early_action, undefined, "last fall's date is past");
  assert.equal(stated.deadlines.regular_decision?.date, "2027-02-15");
  const statedRecord = snapshotAsDeadlineRecord({ school: "Example University", slug: "example-university", checkedAt: feb3.toISOString(), policy: stated });
  assert.equal(statedRecord.deadlines.rd, "2027-02-15");
  assert.equal(statedRecord.cycle, "2026-27", "every date the record holds is the closing cycle's");
  assert.match(formatPolicyLine({ school: "Example University", checkedAt: feb3.toISOString(), policy: stated }), /Regular Decision deadline 2027-02-15 \(2026-27 cycle\)/);

  // A yearless page: next fall's Early Action and this winter's Regular
  // Decision sit in one reading, each named by its own cycle.
  const yearless = extractPolicyFromPages(page("Early Action: November 1\nRegular Decision: February 15"), feb3);
  assert.equal(yearless.deadlines.early_action?.date, "2027-11-01");
  assert.equal(yearless.deadlines.regular_decision?.date, "2027-02-15", "not moved a year later");
  const record = snapshotAsDeadlineRecord({ school: "Example University", slug: "example-university", checkedAt: feb3.toISOString(), policy: yearless });
  assert.equal(record.cycle, "2027-28");
  assert.equal(record.deadlines.ea, "2027-11-01");
  assert.equal(record.deadlines.rd, "2027-02-15");
  assert.equal(record.labels.rd, "Regular Decision (2026-27 cycle)");
  assert.equal(record.labels.ea, undefined);
  const line = formatPolicyLine({ school: "Example University", checkedAt: feb3.toISOString(), policy: yearless });
  assert.match(line, /Early Action deadline 2027-11-01;/);
  assert.match(line, /Regular Decision deadline 2027-02-15 \(2026-27 cycle\)/);
});

test("the student-facing cycle agrees with the scout: a senior keeps the closing cycle until Jul 31", () => {
  for (const [name, clock] of Object.entries(CLOSING_CLOCKS)) {
    for (const side of [server, client]) {
      assert.equal(side.closingCycleStartYear(clock), 2026, `${name}: 2026-27 still has days left`);
      assert.equal(side.applicationCycleStartYear(2027, clock), 2026, `${name}: a senior's own cycle is still running`);
      assert.equal(side.applicationCycleStartYear(2028, clock), 2027, `${name}: a junior plans next fall`);
      assert.equal(side.applicationCycleStartYear(2026, clock), 2027, `${name}: last year's class plans the planning cycle`);
      assert.equal(side.applicationCycleStartYear(null, clock), 2027, name);
    }
  }
  for (const clock of [at("2027-01-31T12:00:00Z"), at("2027-08-01T12:00:00Z"), at("2026-11-03T12:00:00Z")]) {
    for (const side of [server, client]) {
      assert.equal(side.closingCycleStartYear(clock), null, clock.toISOString());
    }
  }
  assert.equal(server.applicationCycleStartYear(2027, at("2027-08-01T12:00:00Z")), 2027, "a graduate plans the current cycle");

  // Each date the scout keeps is placed by its own cycle: the closing
  // cycle's February 15 is a senior's school date and a junior's carried
  // estimate, never a junior's school date; next fall's Early Action is the
  // junior's and not the senior's.
  for (const side of [server, client]) {
    assert.deepEqual(side.dateForOwnCycle("2027-02-15", 2026), { date: "2027-02-15", kind: "school", fromStartYear: 2026 });
    assert.deepEqual(side.dateForOwnCycle("2027-02-15", 2027), { date: "2028-02-15", kind: "carried", fromStartYear: 2026 });
    assert.deepEqual(side.dateForOwnCycle("2027-11-01", 2027), { date: "2027-11-01", kind: "school", fromStartYear: 2027 });
    assert.equal(side.dateForOwnCycle("2027-11-01", 2026), null);
    assert.equal(side.dateForOwnCycle("junk", 2026), null);
    assert.equal(side.dateForOwnCycle("2027-02-15", null), null);
  }
});

test("a snapshot of another cycle is not current, so it is read again on demand", () => {
  const march = at("2027-03-01T12:00:00Z");
  assert.equal(snapshotIsCurrent({ policy: { scoutVersion: SCOUT_VERSION, cycle: "2026-27" } }, march), false);
  assert.equal(snapshotIsCurrent({ policy: { scoutVersion: SCOUT_VERSION, cycle: "2027-28" } }, march), true);
  assert.equal(snapshotIsCurrent({ policy: { scoutVersion: SCOUT_VERSION - 1, cycle: "2027-28" } }, march), false);
  assert.equal(snapshotIsCurrent(null, march), false);
});

test("a student applies in the cycle their class year names, never an earlier one", () => {
  const now = at("2026-11-03T12:00:00Z");
  for (const side of [server, client]) {
    assert.equal(side.applicationCycleStartYear(2027, now), 2026, "a senior applies now");
    assert.equal(side.applicationCycleStartYear(2028, now), 2027, "a junior applies next fall");
    assert.equal(side.applicationCycleStartYear(2030, now), 2029, "a freshman");
    assert.equal(side.applicationCycleStartYear(2026, now), 2026, "a graduate plans for the current cycle");
    assert.equal(side.applicationCycleStartYear(null, now), 2026);
    // In March the junior's cycle is the planning cycle itself.
    assert.equal(side.applicationCycleStartYear(2028, at("2027-03-01T12:00:00Z")), 2027);
  }
});

test("the client twin computes what the server computes", () => {
  const dates = ["2026-08-01", "2026-11-01", "2027-01-05", "2027-07-31", "2028-02-29", "junk", null];
  for (const iso of dates) {
    assert.equal(client.cycleOfDate(iso), server.cycleOfDate(iso), String(iso));
    for (const [from, to] of [[2026, 2027], [2027, 2028], [2026, 2029], [2026, 2026]]) {
      assert.equal(client.shiftDateToCycle(iso, from, to), server.shiftDateToCycle(iso, from, to), `${iso} ${from}->${to}`);
    }
  }
  for (const label of ["2026-27", "2099-00", "2026-28", "junk"]) {
    assert.equal(client.cycleStartYearOf(label), server.cycleStartYearOf(label), label);
  }
  for (const start of [2025, 2026, 2031]) {
    assert.equal(client.cycleLabel(start), server.cycleLabel(start));
    assert.deepEqual(client.typicalDeadlineDates(start), server.typicalDeadlineDates(start));
    for (const [month, day] of [[11, 1], [1, 5], [8, 1], [7, 31]]) {
      assert.equal(client.cycleDate(start, month, day), server.cycleDate(start, month, day));
    }
  }
  assert.equal(server.shiftDateToCycle("2028-02-29", 2027, 2028), "2029-02-28");
  assert.equal(server.cycleOfDate("2027-11-01"), "2027-28");
  assert.equal(server.cycleOfDate("2028-01-05"), "2027-28");
});
