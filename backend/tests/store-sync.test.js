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

// backend-4: the work list found each student's latest snapshot with a
// correlated subquery that sorted the student's whole history again for
// every one of its snapshots (datetime(created_at) no index can serve), and
// it ran synchronously at boot before compaction had trimmed the
// unpruned history of a snapshot per chat answer: seconds to a minute of
// downtime on the deploy that landed it, growing with the square of a
// student's snapshot count. One window pass now ranks every history once.
test("the backfill's work list ranks each history once and picks the same rows", () => {
  const { db, stmts } = store();
  // No sort runs once per row: a temp b-tree under a correlated subquery is
  // the per-snapshot re-sort. (An index probe per row is fine.)
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${stmts.latestSnapshotsWithoutCapabilities.source}`).all();
  const byId = new Map(plan.map((row) => [row.id, row]));
  const underCorrelated = (row) => {
    for (let at = byId.get(row.parent); at; at = byId.get(at.parent)) if (/CORRELATED/i.test(at.detail)) return true;
    return false;
  };
  const resorts = plan.filter((row) => /TEMP B-TREE/i.test(row.detail) && underCorrelated(row));
  assert.deepEqual(resorts, [], plan.map((row) => row.detail).join("\n"));

  const insertSnapshot = db.prepare("INSERT INTO profile_snapshots (id, student_id, snapshot_type, courses_json, ap_scores_json, test_scores_json, activities_json, goals_json, created_at) VALUES (?, ?, 'sync', '[]', '[]', '[]', '[]', '[]', ?)");
  const insertLegacy = db.prepare("INSERT INTO capability_timeline (id, student_id, metric, value, snapshot_id) VALUES (?, ?, 'gpa_uw', 3.5, ?)");
  const history = (sid, count, { sameSecond = false } = {}) => {
    for (let i = 0; i < count; i += 1) {
      insertSnapshot.run(`${sid}-snap-${i}`, sid, sameSecond ? "2026-11-03 12:00:00" : `2026-11-03 12:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`);
    }
  };
  db.transaction(() => {
    // Legacy rows only: its latest snapshot is on the list.
    history("legacy", 120);
    insertLegacy.run("legacy-row", "legacy", null);
    // Two snapshots in one second: the later insert is the latest.
    history("tied", 3, { sameSecond: true });
    insertLegacy.run("tied-row", "tied", null);
    // Its latest snapshot already has rows of its own.
    history("linked", 4);
    insertLegacy.run("linked-row", "linked", "linked-snap-3");
    // No capability rows at all: nothing to link.
    history("fresh", 2);
  })();
  const ids = stmts.latestSnapshotsWithoutCapabilities.all().map((row) => row.id).sort();
  assert.deepEqual(ids, ["legacy-snap-119", "tied-snap-2"]);
  // Each row is the whole snapshot, as the backfill reads it.
  assert.ok(stmts.latestSnapshotsWithoutCapabilities.all().every((row) => row.student_id && row.activities_json === "[]"));
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

// fid-5: the statuses are stored with the snapshot, a change in either one
// is a change, and a row from before the columns (NULL) reads as no
// statement, so the first sync after the migration stores nothing new.
test("the GPA and testing statuses are stored, compared, and read back", () => {
  const { db, stmts } = store();
  const sid = crypto.randomUUID();
  const none = { gpa: null, courses: [], testScores: [] };
  const first = syncStudentData(stmts, sid, { ...none, gpaStatus: "pending", testingStatus: "planned" }, ACTS, [], "Biology");
  const row = stmts.getLatestSnapshot.get(sid);
  assert.equal(row.gpa_status, "pending");
  assert.equal(row.testing_status, "planned");

  const same = syncStudentData(stmts, sid, { ...none, gpaStatus: "pending", testingStatus: "planned" }, ACTS, [], "Biology");
  assert.equal(same.unchanged, true);
  assert.equal(same.revision, first.revision);

  const cleared = syncStudentData(stmts, sid, { ...none, gpaStatus: "pending" }, ACTS, [], "Biology");
  assert.equal(cleared.unchanged, false);
  assert.equal(stmts.getLatestSnapshot.get(sid).testing_status, "");

  // A row written before the columns existed carries NULL.
  db.prepare("UPDATE profile_snapshots SET gpa_status = NULL, testing_status = NULL WHERE student_id = ?").run(sid);
  assert.equal(syncStudentData(stmts, sid, none, ACTS, [], "Biology").unchanged, true);
  assert.equal(syncStudentData(stmts, sid, { ...none, testingStatus: "planned" }, ACTS, [], "Biology").unchanged, false);
});

test("the status columns are added to an existing snapshot table once", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE profile_snapshots (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, snapshot_type TEXT NOT NULL, gpa_unweighted REAL, gpa_weighted REAL, courses_json TEXT, ap_scores_json TEXT, test_scores_json TEXT, activities_json TEXT, major_interest TEXT, goals_json TEXT, trigger TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  db.prepare("INSERT INTO profile_snapshots (id, student_id, snapshot_type) VALUES ('old', 's1', 'sync')").run();
  initRAGTables(db);
  initRAGTables(db);
  const cols = db.prepare("PRAGMA table_info(profile_snapshots)").all().map((r) => r.name);
  assert.ok(cols.includes("gpa_status") && cols.includes("testing_status"), cols.join(","));
  const old = db.prepare("SELECT gpa_status, testing_status FROM profile_snapshots WHERE id = 'old'").get();
  assert.deepEqual({ ...old }, { gpa_status: null, testing_status: null });
});

// debt-8: an encoding accident had replaced the arrow and the dash in the
// milestone titles with "??", and stored rows kept it. New titles carry
// the arrow, and a stored title is repaired once at boot.
test("milestone titles carry their arrow, and stored ones are repaired at boot", () => {
  const { db, stmts } = store();
  const sid = crypto.randomUUID();
  syncStudentData(stmts, sid, profile({ gpa: 3.8 }), [{ name: "Robotics Club", role: "Member" }], [], "Biology");
  syncStudentData(stmts, sid, profile({ gpa: 3.9, sat: 1500 }), [{ name: "Robotics Club", role: "Captain" }], [], "Physics");
  const titles = stmts.getMilestones.all(sid, 50).map((m) => m.title);
  assert.ok(titles.includes("GPA improved: 3.80 → 3.90"), titles.join(" | "));
  assert.ok(titles.includes("SAT updated: 1450 → 1500"), titles.join(" | "));
  assert.ok(titles.includes("Leadership promotion: Robotics Club — Captain"), titles.join(" | "));
  assert.ok(titles.includes("Major interest changed: Biology → Physics"), titles.join(" | "));
  assert.ok(titles.every((t) => !t.includes("??")));

  // The stored forms being repaired, as the accident wrote them.
  const legacy = [
    ["gpa_change", "GPA improved: 3.80 ??3.90"], // encoding-fixture
    ["major_changed", "Major interest changed: Biology ??Physics"], // encoding-fixture
    ["ec_leadership", "Leadership promotion: Robotics Club ??Captain"], // encoding-fixture
    ["ec_added", "New activity: Why?? Club (Member)"],
  ];
  for (const [type, title] of legacy) stmts.insertMilestone.run(crypto.randomUUID(), "legacy", type, title, "{}", "2025-2026");
  initRAGTables(db);
  initRAGTables(db);
  const repaired = stmts.getMilestones.all("legacy", 10).map((m) => m.title).sort();
  assert.deepEqual(repaired, [
    "GPA improved: 3.80 → 3.90",
    "Leadership promotion: Robotics Club — Captain",
    "Major interest changed: Biology → Physics",
    "New activity: Why?? Club (Member)",
  ]);
});
