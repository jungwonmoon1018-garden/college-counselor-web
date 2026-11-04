import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  initRAGTables,
  prepareRAGStatements,
  getDirectStructuredStudentData,
} from "../storage/rag-engine.js";

function freshStmts() {
  const db = new Database(":memory:");
  initRAGTables(db);
  return prepareRAGStatements(db);
}

test("getDirectStructuredStudentData reads GPA/test scores directly from DB tables", () => {
  const stmts = freshStmts();

  stmts.insertSnapshot.run(
    "snap_1",
    "student_1",
    "sync",
    3.92,
    4.41,
    JSON.stringify([
      { name: "AP Calculus BC", type: "ap" },
      { name: "AP Physics C", type: "ap" },
      { name: "English 11 Honors", type: "honors" },
    ]),
    JSON.stringify([
      { exam: "Calculus BC", score: 5 },
      { exam: "Physics C", score: 4 },
    ]),
    JSON.stringify([
      { test: "sat", totalScore: 1540 },
      { test: "act", totalScore: 34 },
    ]),
    JSON.stringify([
      { name: "Science Olympiad" },
      { name: "Robotics" },
    ]),
    "Engineering",
    JSON.stringify([]),
    "test",
  );

  // Capability rows carry the snapshot they were computed from; the latest
  // metrics are the latest snapshot's rows.
  stmts.insertCapability.run("cap_1", "student_1", "gpa_uw", 3.92, 96, 93, "snap_1");
  stmts.insertCapability.run("cap_2", "student_1", "sat_total", 1540, 99, 98, "snap_1");
  stmts.insertCapability.run("cap_3", "student_1", "act_total", 34, 98, null, "snap_1");
  // A row from an older snapshot is history, not a latest metric.
  stmts.insertCapability.run("cap_0", "student_1", "ap_rigor_index", 0.4, null, null, "snap_0");

  const data = getDirectStructuredStudentData(stmts, "student_1");
  assert.equal(data.retrieval, "direct_db");
  assert.deepEqual(data.sourceTables, [
    "profile_snapshots",
    "capability_timeline",
    "baseline_gpa",
    "baseline_sat",
    "baseline_act",
  ]);

  assert.equal(data.profile.gpaUnweighted, 3.92);
  assert.equal(data.profile.gpaWeighted, 4.41);
  assert.equal(data.profile.satTotal, 1540);
  assert.equal(data.profile.actComposite, 34);
  assert.equal(data.profile.apCourseCount, 2);
  assert.equal(data.profile.apExamCount, 2);
  assert.equal(data.profile.apAverageScore, 4.5);
  assert.equal(data.profile.activitiesCount, 2);
  assert.equal(data.profile.majorInterest, "Engineering");

  assert.equal(data.metrics.gpa_uw.value, 3.92);
  assert.equal(data.metrics.gpa_uw.percentileNational, 96);
  assert.equal(data.metrics.sat_total.value, 1540);
  assert.equal(data.metrics.act_total.percentileNational, 98);
  assert.equal(data.metrics.ap_rigor_index, undefined);
});

// Every reader takes the best sitting, as College Fit does; the first entry
// was the oldest, so a retaker read as her first score.
test("the structured read takes the best SAT and ACT sitting, not the first", () => {
  const stmts = freshStmts();
  stmts.insertSnapshot.run(
    "snap_r", "student_r", "sync", 3.7, null, "[]", "[]",
    JSON.stringify([
      { test: "sat", totalScore: 1250, date: "2025-10" },
      { test: "act", totalScore: 26 },
      { test: "sat", totalScore: 1480, date: "2026-03" },
      { test: "act", totalScore: 31 },
    ]),
    "[]", "Biology", "[]", "test",
  );
  const data = getDirectStructuredStudentData(stmts, "student_r");
  assert.equal(data.profile.satTotal, 1480);
  assert.equal(data.profile.actComposite, 31);
});

