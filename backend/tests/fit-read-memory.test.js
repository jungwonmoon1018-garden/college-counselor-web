// tests/fit-read-memory.test.js — the College Fit read the chat quotes
// (rememberFitRead / fitReadsForStudent in server/verified-data.js), against
// the table and upsert server.js defines (copied here; the route test in
// fit-positioning-routes.test.js runs the real ones).
//
// fit-9: a new read inherited the previous read's double-check through the
// upsert's COALESCE, so "Competitive" sat beside October's "with live inputs
// the read moves to High reach"; and rows written before an engine version
// bump kept their labels in the chat. fit-4: a read withheld for lack of
// student data must store no label.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { bindVerifiedData, fitReadsForStudent, rememberFitRead } from "../server/verified-data.js";
import { POSITIONING_MODEL_VERSION } from "../colleges/positioning-engine.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS student_fit_reads (
      student_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      school TEXT NOT NULL,
      label TEXT,
      score REAL,
      admissibility REAL,
      competitiveness REAL,
      fit REAL,
      confidence TEXT,
      provenance_json TEXT,
      verification_json TEXT,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (student_id, slug)
    );
  `);
  const fitReadStmts = {
    upsert: db.prepare(`
      INSERT INTO student_fit_reads (student_id, slug, school, label, score, admissibility, competitiveness, fit, confidence, provenance_json, verification_json, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, slug) DO UPDATE SET
        school = excluded.school, label = excluded.label, score = excluded.score,
        admissibility = excluded.admissibility, competitiveness = excluded.competitiveness, fit = excluded.fit,
        confidence = excluded.confidence, provenance_json = excluded.provenance_json,
        verification_json = COALESCE(excluded.verification_json, student_fit_reads.verification_json),
        computed_at = excluded.computed_at`),
    byStudent: db.prepare("SELECT * FROM student_fit_reads WHERE student_id = ?"),
  };
  const state = { snapshotId: 1 };
  bindVerifiedData({
    fitReadStmts,
    ragStmts: { getLatestSnapshot: { get: () => ({ id: state.snapshotId }) } },
  });
  return { db, fitReadStmts, state };
}

const read = (label, extra = {}) => ({
  schoolName: "Example University",
  overallPositioningLabel: label,
  labelKey: { Reach: "reach", Competitive: "competitive" }[label] || null,
  finalPositioningScore: 33,
  admissibility: { academicReadinessScore: 60 },
  competitiveness: { majorCompetitivenessScore: 50 },
  fit: { institutionalPriorityFitScore: 50 },
  confidence: { evidenceConfidence: "Medium" },
  dataProvenance: { kind: "cds_store" },
  ...extra,
});
const verification = { checkedAt: "2026-10-01T00:00:00.000Z", verdict: "discrepancies_found", checks: [], recomputed: { overallPositioningLabel: "High reach", labelChanged: true } };

test("a double-check stays beside the read it checked and is dropped when the read moves", () => {
  const { state } = setup();
  rememberFitRead("s1", read("Reach"), { verification });
  assert.equal(fitReadsForStudent("s1")[0].verification.verdict, "discrepancies_found");
  // The same read again, same snapshot: the verdict is kept.
  rememberFitRead("s1", read("Reach"));
  assert.equal(fitReadsForStudent("s1")[0].verification?.verdict, "discrepancies_found");
  // A new snapshot and a new label: the old verdict is not carried over.
  state.snapshotId = 2;
  rememberFitRead("s1", read("Competitive"));
  const [row] = fitReadsForStudent("s1");
  assert.equal(row.label, "Competitive");
  assert.equal(row.verification, null);
  assert.equal(row.stale, false);
  assert.equal(row.provenance.modelVersion, POSITIONING_MODEL_VERSION);
  assert.equal(row.provenance.snapshotId, 2);
});

test("a label changed on the same snapshot also drops the verdict", () => {
  setup();
  rememberFitRead("s2", read("Reach"), { verification });
  rememberFitRead("s2", read("Competitive"));
  assert.equal(fitReadsForStudent("s2")[0].verification, null);
});

test("a read from an older snapshot or engine version gives the chat no label", () => {
  const { db, state } = setup();
  rememberFitRead("s3", read("Reach"), { verification });
  state.snapshotId = 5;
  const [stale] = fitReadsForStudent("s3");
  assert.equal(stale.stale, true);
  assert.equal(stale.label, null);
  assert.equal(stale.staleLabel, "Reach");
  assert.equal(stale.verification, null);
  // A row written before versions were recorded (positioning_v2 and earlier).
  db.prepare("INSERT INTO student_fit_reads (student_id, slug, school, label, score, provenance_json, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("s4", "old-school", "Old School", "High reach", 9, JSON.stringify({ kind: "baseline_only" }), "2026-09-01T00:00:00.000Z");
  const [legacy] = fitReadsForStudent("s4");
  assert.equal(legacy.stale, true);
  assert.equal(legacy.label, null);
});

test("a read withheld for lack of student data stores no label or score", () => {
  setup();
  rememberFitRead("s5", read("Not enough data yet", { labelKey: "insufficient_student_data", finalPositioningScore: null, dataProvenance: { kind: "cds_store", studentDataNeeded: ["gpa", "sat_or_act"] } }));
  const [row] = fitReadsForStudent("s5");
  assert.equal(row.label, null);
  assert.equal(row.score, null);
  assert.equal(row.labelKey, "insufficient_student_data");
  assert.deepEqual(row.provenance.studentDataNeeded, ["gpa", "sat_or_act"]);
});
