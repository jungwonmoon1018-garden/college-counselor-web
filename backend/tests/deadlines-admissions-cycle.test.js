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
import { SCOUT_VERSION, extractPolicyFromPages, resolveCycleDate, snapshotIsCurrent } from "../scouts/admissions-policy-scout.js";

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
