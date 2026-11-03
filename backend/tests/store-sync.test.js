// Profile sync storage: an unchanged sync stores nothing, the latest metrics
// are the latest snapshot's own (a cleared score is not reported), the
// profile revision moves only with a stored snapshot, and the history is
// compacted to a bounded window.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import {
  assembleRAGContext,
  backfillLatestCapabilities,
  compactProfileHistory,
  getDirectStructuredStudentData,
  initRAGTables,
  prepareRAGStatements,
  profileRevision,
  seedBaselines,
  syncStudentData,
} from "../storage/rag-engine.js";
import * as baselineData from "../colleges/baseline-data.js";

function store() {
  const db = new Database(":memory:");
  initRAGTables(db);
  const log = console.log;
  console.log = () => {};
  try { seedBaselines(db, baselineData); } finally { console.log = log; }
  return { db, stmts: prepareRAGStatements(db) };
}

const count = (db, table, sid) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE student_id = ?`).get(sid).n;
const profile = ({ gpa = 3.8, sat = 1450, courses = [{ name: "AP Biology", type: "ap", grade: "A" }], tests } = {}) => ({
  gpa: gpa == null ? null : { unweighted: gpa },
  courses,
  testScores: tests ?? (sat ? [{ test: "sat", totalScore: sat }] : []),
});
const ACTS = [{ name: "Robotics Club", role: "Member", category: "STEM" }];

test("an identical sync stores nothing and keeps the revision", () => {
  const { db, stmts } = store();
  const sid = crypto.randomUUID();
  const first = syncStudentData(stmts, sid, profile(), ACTS, ["MIT"], "Biology");
  assert.equal(first.unchanged, false);
  assert.ok(first.revision);
  const before = { snaps: count(db, "profile_snapshots", sid), caps: count(db, "capability_timeline", sid), miles: count(db, "milestones", sid) };

  const second = syncStudentData(stmts, sid, profile(), ACTS, ["MIT"], "Biology", "auto_sync");
  assert.equal(second.unchanged, true);
  assert.deepEqual(second.changes, []);
  assert.equal(second.revision, first.revision);
  assert.equal(count(db, "profile_snapshots", sid), before.snaps);
  assert.equal(count(db, "capability_timeline", sid), before.caps);
  assert.equal(count(db, "milestones", sid), before.miles);
  assert.equal(profileRevision(stmts.getLatestSnapshot.get(sid)), first.revision);
});

test("a change, a removed score and a removed goal each store exactly one snapshot", () => {
  const { db, stmts } = store();
  const sid = crypto.randomUUID();
  const base = syncStudentData(stmts, sid, profile(), ACTS, ["MIT", "Yale"], "Biology");
  const gpa = syncStudentData(stmts, sid, profile({ gpa: 3.9 }), ACTS, ["MIT", "Yale"], "Biology");
  assert.equal(gpa.unchanged, false);
  assert.notEqual(gpa.revision, base.revision);
  assert.equal(count(db, "profile_snapshots", sid), 2);
  // detectChanges sees additions only; a removal is still a change to store.
  const noSat = syncStudentData(stmts, sid, profile({ gpa: 3.9, sat: null }), ACTS, ["MIT", "Yale"], "Biology");
  assert.equal(noSat.unchanged, false);
  const oneGoal = syncStudentData(stmts, sid, profile({ gpa: 3.9, sat: null }), ACTS, ["MIT"], "Biology");
  assert.equal(oneGoal.unchanged, false);
  assert.equal(count(db, "profile_snapshots", sid), 4);
});

test("a cleared SAT and GPA leave no latest metric, while the history keeps them", () => {
  const { stmts } = store();
  const sid = crypto.randomUUID();
  syncStudentData(stmts, sid, profile({ gpa: 3.9, sat: 1600 }), ACTS, [], "Biology");
  const metricsBefore = stmts.getLatestCapabilities.all(sid).map((c) => c.metric);
  assert.ok(metricsBefore.includes("sat_total"));
  assert.ok(metricsBefore.includes("gpa_uw"));

  syncStudentData(stmts, sid, profile({ gpa: null, sat: null }), ACTS, [], "Biology");
  const latest = stmts.getLatestCapabilities.all(sid).map((c) => c.metric);
  assert.equal(latest.includes("sat_total"), false);
  assert.equal(latest.includes("gpa_uw"), false);
  assert.ok(latest.includes("ec_count"));

  const rag = assembleRAGContext(stmts, sid, "holistic");
  assert.doesNotMatch(rag.studentContext.textSummary, /sat_total|gpa_uw/);
  const direct = getDirectStructuredStudentData(stmts, sid);
  assert.equal(direct.profile.satTotal, null);
  assert.equal(direct.metrics.sat_total, undefined);
  assert.equal(stmts.getCapabilityTrend.all(sid, "sat_total").length, 1, "the trend read keeps the history");
});

test("two syncs in the same second give one row per metric, the newer value", () => {
  const { stmts } = store();
  const sid = crypto.randomUUID();
  syncStudentData(stmts, sid, profile({ gpa: 3.5 }), ACTS, [], "Biology");
  syncStudentData(stmts, sid, profile({ gpa: 3.8 }), ACTS, [], "Biology");
  const gpaRows = stmts.getLatestCapabilities.all(sid).filter((c) => c.metric === "gpa_uw");
  assert.equal(gpaRows.length, 1);
  assert.equal(gpaRows[0].value, 3.8);
});

test("an identical sync keeps an improving GPA trend", () => {
  const { db, stmts } = store();
  const sid = crypto.randomUUID();
  const trend = () => (String(db.prepare("SELECT reasoning_json FROM student_directionality WHERE student_id = ? ORDER BY updated_at DESC LIMIT 1").get(sid)?.reasoning_json || "").match(/trend: (\w+)/) || [])[1];
  syncStudentData(stmts, sid, profile({ gpa: 3.4, sat: null }), ACTS, [], "Biology");
  const improved = syncStudentData(stmts, sid, profile({ gpa: 3.9, sat: null }), ACTS, [], "Biology");
  const momentum = improved.directionality?.factors?.academic_momentum;
  assert.equal(trend(), "improving");
  const again = syncStudentData(stmts, sid, profile({ gpa: 3.9, sat: null }), ACTS, [], "Biology");
  assert.equal(again.unchanged, true);
  assert.equal(trend(), "improving");
  assert.equal(db.prepare("SELECT academic_momentum AS m FROM student_directionality WHERE student_id = ?").get(sid)?.m ?? momentum, momentum);
});

test("a snapshot whose rows predate snapshot_id is linked once by the backfill", () => {
  const { db, stmts } = store();
  const sid = crypto.randomUUID();
  syncStudentData(stmts, sid, profile({ gpa: 3.9, sat: 1500 }), ACTS, [], "Biology");
  // What a database migrated from before the column looks like.
  db.prepare("UPDATE capability_timeline SET snapshot_id = NULL WHERE student_id = ?").run(sid);
  assert.equal(stmts.getLatestCapabilities.all(sid).length, 0);
  assert.equal(backfillLatestCapabilities(stmts).students, 1);
  const metrics = stmts.getLatestCapabilities.all(sid).map((c) => c.metric);
  assert.ok(metrics.includes("sat_total") && metrics.includes("gpa_uw"));
  assert.equal(backfillLatestCapabilities(stmts).students, 0, "idempotent");
});

test("compaction keeps the newest 50 snapshots and their rows, and bounds the rest", () => {
  const { db, stmts } = store();
  const sid = crypto.randomUUID();
  const other = crypto.randomUUID();
  for (let i = 0; i < 60; i += 1) {
    syncStudentData(stmts, sid, profile({ gpa: 3 + i / 100 }), ACTS, [], "Biology");
  }
  syncStudentData(stmts, other, profile(), ACTS, [], "Biology");
  const latestBefore = stmts.getLatestSnapshot.get(sid).id;
  const metricsBefore = stmts.getLatestCapabilities.all(sid);
  // Legacy rows with no snapshot: kept to a bounded window per metric.
  const insertLegacy = db.prepare("INSERT INTO capability_timeline (id, student_id, metric, value, computed_at) VALUES (?, ?, 'sat_total', ?, datetime('now', ?))");
  for (let i = 0; i < 70; i += 1) insertLegacy.run(crypto.randomUUID(), sid, 1200 + i, `-${i + 1} days`);
  const insertMilestone = db.prepare("INSERT INTO milestones (id, student_id, type, title, created_at) VALUES (?, ?, 'gpa_change', 'x', datetime('now', ?))");
  for (let i = 0; i < 220; i += 1) insertMilestone.run(crypto.randomUUID(), sid, `-${i + 1} hours`);

  const result = compactProfileHistory(db);
  assert.ok(result.deleted > 0);
  assert.equal(count(db, "profile_snapshots", sid), 50);
  assert.equal(count(db, "profile_snapshots", other), 1);
  assert.equal(stmts.getLatestSnapshot.get(sid).id, latestBefore);
  assert.deepEqual(stmts.getLatestCapabilities.all(sid), metricsBefore);
  const orphanRows = db.prepare("SELECT COUNT(*) AS n FROM capability_timeline WHERE snapshot_id IS NOT NULL AND snapshot_id NOT IN (SELECT id FROM profile_snapshots)").get().n;
  assert.equal(orphanRows, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM capability_timeline WHERE student_id = ? AND snapshot_id IS NULL").get(sid).n, 50);
  assert.equal(count(db, "milestones", sid), 200);
  assert.equal(compactProfileHistory(db).deleted, 0, "a second run removes nothing");
});

test("a narrative save that fails part-way leaves the prior narrative active", async () => {
  const { getActiveNarrative, saveNarrative } = await import("../activities/narrative-store.js");
  const { stmts } = store();
  const text = (topic) => `I build ${topic} because I care about how people in my neighborhood get reliable information, and I keep working on it every week with friends from school and the library volunteers who helped me start.`;
  saveNarrative(stmts.narrative, "s1", text("radio tools"));
  const failing = { ...stmts.narrative, insert: { run: () => { throw new Error("disk full"); } } };
  assert.throws(() => saveNarrative(failing, "s1", text("map tools")), /disk full/);
  assert.match(getActiveNarrative(stmts.narrative, "s1").narrativeText, /radio tools/);
});
