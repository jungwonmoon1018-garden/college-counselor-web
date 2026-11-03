// Account erasure (server/student-data.js): the account ends first, every
// row in the three databases goes, the audit rows that could lead back to
// the student go (or, for content-free events, lose their hint), and a
// write that lands after the delete is swept by the tombstone sweep.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initAuthStore } from "../security/security-auth.js";
import { initUsageBudget } from "../security/usage-budget.js";
import { initRAGTables, prepareRAGStatements, syncStudentData } from "../storage/rag-engine.js";
import { initPIIVault, preparePIIStatements, storeStudentPII } from "../storage/pii-vault.js";
import { initVectorStore } from "../storage/vector-store.js";
import { configureChatEncryption } from "../chat/chat-history.js";
import { initCollegeResearch } from "../colleges/college-research.js";
import { bindStudentData, eraseStudent, erasureIdHash, purgeStudentAudit, sweepErasedStudents } from "../server/student-data.js";

configureChatEncryption("ef".repeat(32));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-erasure-"));
  const db = new Database(":memory:");
  const authStore = initAuthStore(db, { sessionTtlMs: 60_000 });
  initUsageBudget(db);
  initRAGTables(db);
  initCollegeResearch(db);
  db.exec(`CREATE TABLE audit_events (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL, user_hint TEXT, details TEXT, ip_hash TEXT, created_at TEXT DEFAULT (datetime('now')));
           CREATE TABLE notification_queue (id TEXT PRIMARY KEY, recipient_email_hash TEXT, recipient_email_encrypted TEXT, student_hint TEXT, notification_type TEXT, message TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')));`);
  const piiVault = initPIIVault(dir, "ef".repeat(32), "test");
  const vectorStore = initVectorStore(dir, "test");
  // The simulation sidecar's databases are its own; erasure asks it to drop
  // the student's scenarios.
  const sidecarCalls = [];
  const callSimulationSidecar = async (pathname, options = {}) => {
    sidecarCalls.push(`${options.method || "GET"} ${pathname}`);
    return { deleted: true };
  };
  const deps = { DATA_DIR: dir, EC_ATTACHMENTS_DIR: path.join(dir, "ec-attachments"), authStore, db, piiVault, vectorStore, callSimulationSidecar, sidecarCalls };
  bindStudentData(deps);
  // The sync starts an asynchronous strength recompute; let it finish first.
  const close = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    db.close(); piiVault.db.close(); vectorStore.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ...deps, dir, stmts: prepareRAGStatements(db), piiStmts: preparePIIStatements(piiVault), close };
}

function seedStudent(ctx, label, activity = "Peer Line") {
  const studentId = crypto.randomUUID();
  const emailHash = crypto.createHash("sha256").update(`email_salt_cc:${label}@example.test`).digest("hex");
  ctx.authStore.createStudentCredential(studentId, emailHash, "correct horse battery staple", { grade: 11 });
  ctx.authStore.issueStudentSession(emailHash, studentId);
  storeStudentPII(ctx.piiStmts, ctx.piiVault, studentId, { name: label, email: `${label}@example.test` });
  syncStudentData(ctx.stmts, studentId, { gpa: { unweighted: 3.62 }, courses: [], testScores: [] }, [{ name: activity, role: "Founder" }], [], "Biology");
  const audit = ctx.db.prepare("INSERT INTO audit_events (id, timestamp, type, user_hint, details, ip_hash) VALUES (?, ?, ?, ?, ?, ?)");
  // What the sync route wrote before 2026-11-03: content, under the email hash.
  audit.run(crypto.randomUUID(), new Date().toISOString(), "profile_ec_added", emailHash.slice(0, 12), "New activity: Peer Line (Founder)", "iphash");
  audit.run(crypto.randomUUID(), new Date().toISOString(), "profile_gpa_set", studentId.slice(0, 12), "gpa_set", "iphash");
  audit.run(crypto.randomUUID(), new Date().toISOString(), "crisis_detected", studentId.slice(0, 12), "crisis_policy_triggered", "iphash");
  ctx.db.prepare("INSERT INTO notification_queue (id, student_hint, message) VALUES (?, ?, 'x')").run(crypto.randomUUID(), studentId.slice(0, 12));
  ctx.vectorStore.db.prepare("INSERT INTO embeddings (id, source_type, source_id, source_name, content_text, content_hash) VALUES (?, 'student_profile', ?, 'x', 'x', 'h')").run(crypto.randomUUID(), studentId);
  fs.mkdirSync(path.join(ctx.EC_ATTACHMENTS_DIR, studentId), { recursive: true });
  fs.writeFileSync(path.join(ctx.EC_ATTACHMENTS_DIR, studentId, "file.txt"), "evidence");
  return { studentId, emailHash };
}

function rowsFor(ctx, studentId, emailHash) {
  const hits = [];
  for (const [label, database] of [["counselor", ctx.db], ["vault", ctx.piiVault.db], ["vectors", ctx.vectorStore.db]]) {
    for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      const cols = database.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name);
      for (const col of cols.filter((c) => ["student_id", "email_hash", "source_id", "user_hint", "student_hint"].includes(c))) {
        for (const needle of [studentId, emailHash, studentId.slice(0, 12), emailHash.slice(0, 12)]) {
          const n = database.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE "${col}" = ?`).get(needle).n;
          if (n) hits.push(`${label}:${name}.${col} x${n}`);
        }
      }
    }
  }
  return hits;
}

test("erasure removes the student's rows and files, and leaves another student's alone", async () => {
  const ctx = setup();
  try {
    const gone = seedStudent(ctx, "erased");
    const kept = seedStudent(ctx, "kept");
    // The sync's strength recompute finishes before a separate delete
    // request arrives; the next test covers a write that lands after it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(rowsFor(ctx, gone.studentId, gone.emailHash).length > 5);
    await eraseStudent(gone);
    assert.deepEqual(rowsFor(ctx, gone.studentId, gone.emailHash), []);
    assert.equal(ctx.authStore.studentExists(gone.studentId), false);
    assert.equal(fs.existsSync(path.join(ctx.EC_ATTACHMENTS_DIR, gone.studentId)), false);
    // The content-free crisis event stays for the counselor's counts, with
    // nothing in it that points back.
    const crisis = ctx.db.prepare("SELECT user_hint, ip_hash FROM audit_events WHERE type = 'crisis_detected' AND user_hint IS NULL").all();
    assert.equal(crisis.length, 1);
    assert.equal(crisis[0].ip_hash, null);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE details LIKE '%Peer Line%' AND user_hint = ?").get(gone.emailHash.slice(0, 12)).n, 0);
    // The other student is untouched.
    assert.ok(rowsFor(ctx, kept.studentId, kept.emailHash).length > 5);
    assert.equal(ctx.authStore.studentExists(kept.studentId), true);
    // The tombstone holds a hash, never the id.
    const tombstone = ctx.db.prepare("SELECT * FROM erasure_tombstones").get();
    assert.equal(tombstone.id_hash, erasureIdHash(gone.studentId));
    assert.doesNotMatch(JSON.stringify(tombstone), new RegExp(gone.studentId));
  } finally {
    await ctx.close();
  }
});

test("a write that lands after the delete is swept, and a live account never is", async () => {
  const ctx = setup();
  try {
    const gone = seedStudent(ctx, "late");
    const live = seedStudent(ctx, "live");
    await eraseStudent(gone);
    // The auto-narrative's model call returned after the delete and wrote.
    ctx.stmts.insertUsage.run(gone.studentId, "openrouter:model", 10, 10, "administrator");
    ctx.stmts.insertSnapshot.run(crypto.randomUUID(), gone.studentId, "sync", null, null, "[]", "[]", "[]", "[]", null, "[]", "late");
    fs.mkdirSync(path.join(ctx.EC_ATTACHMENTS_DIR, gone.studentId), { recursive: true });
    assert.ok(rowsFor(ctx, gone.studentId, gone.emailHash).length > 0);

    const swept = await sweepErasedStudents();
    assert.equal(swept.deleted, 1);
    assert.deepEqual(rowsFor(ctx, gone.studentId, gone.emailHash), []);
    assert.equal(fs.existsSync(path.join(ctx.EC_ATTACHMENTS_DIR, gone.studentId)), false);
    assert.ok(rowsFor(ctx, live.studentId, live.emailHash).length > 5);
    assert.equal((await sweepErasedStudents()).deleted, 0);
  } finally {
    await ctx.close();
  }
});

// backend-2: erasure deleted only from tables with a student_id column, and
// these carry the student some other way. The College Fit double-check is
// cached under "fitverify:<student id>:<school>:<snapshot>:<version>" (one
// row per profile snapshot, with the student's fit label and score for that
// school) and nothing ever removed it. A notification names its recipient
// by the full email hash. The EC caches are shared by content and keyed by
// the student's own activity names and narrative hashes; the narrative-fit
// rows hold a model-written reason about the student's narrative. The
// simulation sidecar keeps a scenario's base profile (the minor's whole
// profile and narrative) in databases of its own.
test("erasure removes the rows keyed by the student's id, email hash, activity names and narrative", async () => {
  const ctx = setup();
  try {
    const gone = seedStudent(ctx, "keyed", "Harbor Tide Tutors");
    const kept = seedStudent(ctx, "neighbor", "Robotics Club");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cache = ctx.db.prepare("INSERT INTO college_research_cache (cache_key, kind, slug, display_name, payload_json, fetched_at) VALUES (?, ?, ?, ?, ?, '2026-11-03T00:00:00.000Z')");
    const fit = JSON.stringify({ verdict: "consistent", original: { label: "Reach", score: 41 } });
    for (const snapshot of ["snap-1", "snap-2"]) cache.run(`fitverify:${gone.studentId}:example-university:${snapshot}:v9`, "fitverify", "example-university", "Example University", fit);
    cache.run(`fitverify:${kept.studentId}:example-university:snap-3:v9`, "fitverify", "example-university", "Example University", fit);
    // An id that only starts with the erased one is someone else's.
    cache.run(`fitverify:${gone.studentId}0:example-university:snap-4:v9`, "fitverify", "example-university", "Example University", fit);
    cache.run("values:example-university", "values", "example-university", "Example University", "{}");
    ctx.db.prepare("INSERT INTO notification_queue (id, recipient_email_hash, message) VALUES (?, ?, 'x')").run(crypto.randomUUID(), gone.emailHash);
    ctx.db.prepare("INSERT INTO student_narratives (id, student_id, narrative_text, narrative_hash) VALUES (?, ?, 'I tutor kids at the harbor.', 'narrative-hash-gone')").run(crypto.randomUUID(), gone.studentId);
    const component = ctx.db.prepare("INSERT INTO ec_component_cache (cache_key, factor, score, reasoning_json, source, input_sig, created_at) VALUES (?, ?, 0.5, ?, 'llm', ?, datetime('now'))");
    // A narrative-fit read of an activity the student has since removed:
    // only the narrative hash leads back to them.
    component.run("k-narrative", "narrative_fit", JSON.stringify({ reason: "The harbor tutoring carries the story." }), JSON.stringify({ ecName: "Old Club", ecHash: "e", narrativeHash: "narrative-hash-gone", themesHash: "t" }));
    ctx.db.prepare("INSERT INTO ec_prestige_cache (cache_key, activity_name, score, rationale, source, created_at) VALUES ('p-gone', 'Harbor Tide Tutors', 0.2, 'r', 'catalog', datetime('now')), ('p-kept', 'Robotics Club', 0.4, 'r', 'catalog', datetime('now'))").run();
    // The narrative-fit model cache, once its rows record the narrative's
    // hash beside the hashed key.
    ctx.db.exec("ALTER TABLE narrative_fit_cache ADD COLUMN narrative_hash TEXT");
    ctx.db.prepare("INSERT INTO narrative_fit_cache (cache_key, score, reason, narrative_hash) VALUES ('nf-gone', 0.7, 'The tutoring fits the harbor story.', 'narrative-hash-gone'), ('nf-other', 0.3, 'x', 'narrative-hash-other')").run();
    const componentRows = (name) => ctx.db.prepare("SELECT COUNT(*) AS n FROM ec_component_cache WHERE input_sig LIKE ?").get(`%${name}%`).n;
    assert.ok(componentRows("Harbor Tide Tutors") > 0, "the sync's strength read cached the activity");
    assert.ok(componentRows("Robotics Club") > 0);

    await eraseStudent(gone);

    const keys = ctx.db.prepare("SELECT cache_key FROM college_research_cache ORDER BY cache_key").all().map((row) => row.cache_key);
    assert.deepEqual(keys.filter((key) => key.includes(gone.studentId + ":")), [], "the College Fit double-check rows go");
    assert.ok(keys.includes(`fitverify:${kept.studentId}:example-university:snap-3:v9`));
    assert.ok(keys.includes(`fitverify:${gone.studentId}0:example-university:snap-4:v9`));
    assert.ok(keys.includes("values:example-university"));
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM notification_queue WHERE recipient_email_hash = ?").get(gone.emailHash).n, 0);
    assert.equal(componentRows("Harbor Tide Tutors"), 0);
    assert.equal(componentRows("narrative-hash-gone"), 0);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM ec_prestige_cache WHERE activity_name = 'Harbor Tide Tutors'").get().n, 0);
    assert.deepEqual(ctx.db.prepare("SELECT cache_key FROM narrative_fit_cache").all().map((row) => row.cache_key), ["nf-other"]);
    // The other student's cached reads stay.
    assert.ok(componentRows("Robotics Club") > 0);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM ec_prestige_cache WHERE activity_name = 'Robotics Club'").get().n, 1);
    assert.deepEqual(ctx.sidecarCalls, [`DELETE /students/${encodeURIComponent(gone.studentId)}`]);
  } finally {
    await ctx.close();
  }
});

// The daily sweep finds an erased id in a fitverify key too: a double-check
// that finished after the delete, or a restored backup, wrote one back.
test("the tombstone sweep finds an erased student's College Fit double-check rows", async () => {
  const ctx = setup();
  try {
    const gone = seedStudent(ctx, "late-fit");
    // The sync's strength read lands first, so the fitverify key is the
    // only place the sweep can find the id.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await eraseStudent(gone);
    ctx.sidecarCalls.length = 0;
    ctx.db.prepare("INSERT INTO college_research_cache (cache_key, kind, slug, display_name, payload_json, fetched_at) VALUES (?, 'fitverify', 'example-university', 'Example University', '{}', '2026-11-03T00:00:00.000Z')")
      .run(`fitverify:${gone.studentId}:example-university:snap-9:v9`);
    const swept = await sweepErasedStudents();
    assert.equal(swept.deleted, 1);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM college_research_cache WHERE kind = 'fitverify'").get().n, 0);
    assert.deepEqual(ctx.sidecarCalls, [`DELETE /students/${encodeURIComponent(gone.studentId)}`]);
  } finally {
    await ctx.close();
  }
});

test("the audit purge deletes content-bearing rows and unlinks content-free ones", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE audit_events (id TEXT PRIMARY KEY, timestamp TEXT, type TEXT, user_hint TEXT, details TEXT, ip_hash TEXT)");
  const insert = db.prepare("INSERT INTO audit_events VALUES (?, '2026-11-03', ?, ?, ?, 'ip')");
  insert.run("a", "profile_ec_added", "emailhint123", "New activity: X");
  insert.run("b", "profile_gpa_set", "studentid123", "gpa_set");
  insert.run("c", "consent_granted", "studentid123", "ai_interaction by student");
  insert.run("d", "profilex", "studentid123", "not a profile_ row");
  insert.run("e", "profile_gpa_set", "otherstudent", "gpa_set");
  const result = purgeStudentAudit(db, { studentId: "studentid123-rest", emailHash: "emailhint123-rest" });
  assert.deepEqual(result, { deleted: 2, unlinked: 2 });
  const rows = Object.fromEntries(db.prepare("SELECT id, user_hint FROM audit_events").all().map((r) => [r.id, r.user_hint]));
  assert.deepEqual(rows, { c: null, d: null, e: "otherstudent" });
  db.close();
});
