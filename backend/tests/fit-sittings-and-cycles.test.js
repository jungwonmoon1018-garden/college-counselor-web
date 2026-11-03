// tests/fit-sittings-and-cycles.test.js — the two pure helpers College Fit
// leans on since 2026-11-03: which SAT/ACT sitting a reader takes
// (academics/test-sittings.js), and Common Data Set cycles read from the
// data and the clock (cds/cds-cycle.js).
import test from "node:test";
import assert from "node:assert/strict";

import { chooseTestSitting, testSittings } from "../academics/test-sittings.js";
import { cycleAge, cycleStartYear, findCycleLabel, newestCdsCycleStart, normalizeCycleLabel, scorecardDataYear } from "../cds/cds-cycle.js";

const march = { test: "sat", totalScore: 1250, sections: { readingWriting: 620, math: 630 }, date: "2026-03" };
const october = { test: "sat", totalScore: 1480, sections: { readingWriting: 730, math: 750 }, date: "2026-10" };

test("the best sitting is the highest total, a tie going to the later one", () => {
  assert.equal(chooseTestSitting([march, october], "sat"), october);
  assert.equal(chooseTestSitting([october, march], "sat"), october);
  assert.equal(chooseTestSitting([october, march], "SAT"), october, "the test name is read case-blind");
  const tieEarly = { test: "sat", totalScore: 1480, date: "2026-03" };
  assert.equal(chooseTestSitting([october, tieEarly], "sat"), october);
  assert.equal(chooseTestSitting([tieEarly, october], "sat"), october);
  // Undated sittings: the later entry was added later.
  const a = { test: "act", totalScore: 30 };
  const b = { test: "act", totalScore: 30 };
  assert.equal(chooseTestSitting([a, b], "act"), b);
  assert.equal(chooseTestSitting([march, october], "act"), null);
  assert.equal(chooseTestSitting(null, "sat"), null);
  assert.equal(chooseTestSitting([{ test: "sat", totalScore: null }], "sat"), null, "a sitting without a total is not a sitting");
});

test("the latest sitting goes by date, then by place in the list", () => {
  const lowerButLater = { test: "sat", totalScore: 1400, date: "2026-12" };
  assert.equal(chooseTestSitting([october, lowerButLater, march], "sat", { mode: "latest" }), lowerButLater);
  assert.equal(chooseTestSitting([october, lowerButLater, march], "sat", { mode: "best" }), october);
  const undated = { test: "sat", totalScore: 1300 };
  assert.equal(chooseTestSitting([march, undated], "sat", { mode: "latest" }), undated);
  assert.deepEqual(testSittings([march, { test: "act", totalScore: 30 }, october], "sat").map((s) => s.index), [0, 2]);
});

test("CDS cycles are read from labels and the clock, never a fixed year", () => {
  assert.equal(normalizeCycleLabel("2025-26"), "2025-26");
  assert.equal(normalizeCycleLabel(" 2025-2026 "), "2025-26");
  assert.equal(normalizeCycleLabel("2025–26"), "2025-26");
  assert.equal(normalizeCycleLabel("2025-27"), null, "the second half is the next year");
  assert.equal(normalizeCycleLabel("Notes"), null);
  assert.equal(findCycleLabel("CDS 2025-2026"), "2025-26");
  assert.equal(findCycleLabel("Common Data Set 2024–25 (PDF)"), "2024-25");
  assert.equal(findCycleLabel("Notes"), null);
  assert.equal(findCycleLabel("2025-27"), null);
  assert.equal(cycleStartYear("2025-26"), 2025);
  assert.equal(cycleStartYear(2024), 2024);
  assert.equal(cycleStartYear("2024"), 2024);
  assert.equal(cycleStartYear(null), null);
  assert.equal(cycleStartYear("CDS"), null);
  // Most schools have published a cycle by the June after its fall.
  assert.equal(newestCdsCycleStart(new Date("2026-11-03T00:00:00Z")), 2025);
  assert.equal(newestCdsCycleStart(new Date("2026-05-31T00:00:00Z")), 2024);
  assert.equal(newestCdsCycleStart(new Date("2026-06-01T00:00:00Z")), 2025);
  assert.equal(cycleAge("2025-26", new Date("2026-11-03T00:00:00Z")), 0);
  assert.equal(cycleAge("2026-27", new Date("2026-11-03T00:00:00Z")), 0, "newer than the newest is current");
  assert.equal(cycleAge("2025-26", new Date("2029-09-01T00:00:00Z")), 3);
  // The double-check's Scorecard year: 2024 today, as it was hard-coded,
  // and moving with the seasons.
  assert.equal(scorecardDataYear(new Date("2026-11-03T00:00:00Z")), 2024);
  assert.equal(scorecardDataYear(new Date("2028-11-01T00:00:00Z")), 2026);
});
