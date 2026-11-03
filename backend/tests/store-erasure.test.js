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
import { bindStudentData, eraseStudent, erasureIdHash, purgeStudentAudit, sweepErasedStudents } from "../server/student-data.js";

configureChatEncryption("ef".repeat(32));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-erasure-"));
  const db = new Database(":memory:");
  const authStore = initAuthStore(db, { sessionTtlMs: 60_000 });
  initUsageBudget(db);
  initRAGTables(db);
  db.exec(`CREATE TABLE audit_events (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, type TEXT NOT NULL, user_hint TEXT, details TEXT, ip_hash TEXT, created_at TEXT DEFAULT (datetime('now')));
           CREATE TABLE notification_queue (id TEXT PRIMARY KEY, recipient_email_hash TEXT, recipient_email_encrypted TEXT, student_hint TEXT, notification_type TEXT, message TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')));`);
  const piiVault = initPIIVault(dir, "ef".repeat(32), "test");
  const vectorStore = initVectorStore(dir, "test");
  const deps = { DATA_DIR: dir, EC_ATTACHMENTS_DIR: path.join(dir, "ec-attachments"), authStore, db, piiVault, vectorStore };
  bindStudentData(deps);
  // The sync starts an asynchronous strength recompute; let it finish first.
  const close = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    db.close(); piiVault.db.close(); vectorStore.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ...deps, dir, stmts: prepareRAGStatements(db), piiStmts: preparePIIStatements(piiVault), close };
}

function seedStudent(ctx, label) {
  const studentId = crypto.randomUUID();
  const emailHash = crypto.createHash("sha256").update(`email_salt_cc:${label}@example.test`).digest("hex");
  ctx.authStore.createStudentCredential(studentId, emailHash, "correct horse battery staple", { grade: 11 });
  ctx.authStore.issueStudentSession(emailHash, studentId);
  storeStudentPII(ctx.piiStmts, ctx.piiVault, studentId, { name: label, email: `${label}@example.test` });
  syncStudentData(ctx.stmts, studentId, { gpa: { unweighted: 3.62 }, courses: [], testScores: [] }, [{ name: "Peer Line", role: "Founder" }], [], "Biology");
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
