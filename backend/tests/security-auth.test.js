import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import {
  initAuthStore,
  isLoopbackAddress,
  normalizeEmail,
  PASSWORD_KDF_CURRENT,
} from "../security/security-auth.js";

function store() {
  const db = new Database(":memory:");
  return { db, auth: initAuthStore(db, { sessionTtlMs: 60_000 }) };
}

test("student credentials require a password and duplicate email cannot authenticate", () => {
  const { db, auth } = store();
  assert.throws(() => auth.createStudentCredential("s1", "email-hash", "short"), /12-256/);
  const created = auth.createStudentCredential("s1", "email-hash", "correct horse battery staple", { grade: 11 });
  assert.ok(created.recoveryCode.length >= 30);
  assert.equal(db.prepare("SELECT password_kdf FROM student_credentials").get().password_kdf, PASSWORD_KDF_CURRENT);
  assert.equal(auth.authenticateStudent("email-hash", "wrong password value"), null);
  assert.equal(auth.authenticateStudent("email-hash", "correct horse battery staple").studentId, "s1");
  assert.throws(
    () => auth.createStudentCredential("s2", "email-hash", "another secure password", { grade: 11 }),
    (error) => error.code === "account_exists",
  );
  db.close();
});

test("successful legacy login migrates the password hash without invalidating the account", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE student_credentials (
    student_id TEXT PRIMARY KEY,
    email_hash TEXT UNIQUE NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    recovery_hash TEXT NOT NULL,
    grade INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const password = "legacy correct horse password";
  const salt = crypto.randomBytes(16).toString("hex");
  const legacyHash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
  db.prepare(`INSERT INTO student_credentials
    (student_id, email_hash, password_salt, password_hash, recovery_hash, grade, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("legacy-student", "legacy-email", salt, legacyHash, "0".repeat(64), 11, 1, 1);

  const auth = initAuthStore(db, { sessionTtlMs: 60_000 });
  assert.equal(db.prepare("SELECT password_kdf FROM student_credentials").get().password_kdf, "scrypt-v1");
  assert.equal(auth.authenticateStudent("legacy-email", password).studentId, "legacy-student");
  const upgraded = db.prepare("SELECT password_kdf, password_hash FROM student_credentials").get();
  assert.equal(upgraded.password_kdf, PASSWORD_KDF_CURRENT);
  assert.notEqual(upgraded.password_hash, legacyHash);
  assert.equal(auth.authenticateStudent("legacy-email", password).studentId, "legacy-student");
  db.close();
});

test("student sessions are hashed, survive store reads, and logout-all revokes them", () => {
  const { db, auth } = store();
  auth.createStudentCredential("s1", "email-hash", "correct horse battery staple", { grade: 11 });
  const token = auth.issueStudentSession("email-hash", "s1");
  assert.equal(db.prepare("SELECT token_hash FROM session_tokens").get().token_hash.includes(token), false);
  assert.equal(auth.validateStudentSession(token).studentId, "s1");
  auth.revokeAllStudentSessions("s1");
  assert.equal(auth.validateStudentSession(token), null);
  db.close();
});

test("student recovery rotates recovery code and revokes prior sessions", () => {
  const { db, auth } = store();
  const first = auth.createStudentCredential("s1", "email-hash", "correct horse battery staple", { grade: 11 });
  const oldToken = auth.issueStudentSession("email-hash", "s1");
  const recovered = auth.recoverStudent("email-hash", first.recoveryCode, "new correct horse password");
  assert.ok(recovered.recoveryCode);
  assert.equal(auth.validateStudentSession(oldToken), null);
  assert.equal(auth.authenticateStudent("email-hash", "correct horse battery staple"), null);
  assert.equal(auth.authenticateStudent("email-hash", "new correct horse password").studentId, "s1");
  assert.equal(auth.recoverStudent("email-hash", first.recoveryCode, "third correct horse password"), null);
  db.close();
});

test("admin session is cookie-compatible and mutations require its CSRF token", () => {
  const { db, auth } = store();
  const boot = auth.bootstrapAdmin("administrator password 123");
  assert.equal(auth.validateAdminSession(boot.token), true);
  assert.equal(auth.validateAdminSession(boot.token, "wrong", true), false);
  assert.equal(auth.validateAdminSession(boot.token, boot.csrfToken, true), true);
  auth.revokeAdminSession(boot.token);
  assert.equal(auth.validateAdminSession(boot.token), false);
  assert.throws(() => auth.bootstrapAdmin("another administrator password"), (error) => error.code === "admin_exists");
  db.close();
});

test("normalization and loopback checks reject ambiguous identities and remote hosts", () => {
  assert.equal(normalizeEmail("  ＴＥＳＴ@Example.COM  "), "test@example.com");
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.20"), false);
});

// ─── Grade from class (decision of 2026-11-03) ──────────────────────────
// The grade used to be fixed at registration: a junior stayed a junior, on
// the junior budget cap, through senior year. The account now stores its
// class (graduation year) and reads the grade from the date, on an Aug 1
// school-year boundary, held to 9-12.
test("the grade advances on Aug 1 from the class stored at registration", async () => {
  const { classOfForGrade, gradeForClassOf, schoolYearStart } = await import("../shared/school-year.js");
  assert.equal(schoolYearStart(new Date("2027-07-31T23:59:00Z")), 2026);
  assert.equal(schoolYearStart(new Date("2027-08-01T00:00:00Z")), 2027);
  assert.equal(classOfForGrade(11, new Date("2026-10-01T00:00:00Z")), 2028);
  assert.equal(gradeForClassOf(2028, new Date("2027-07-31T12:00:00Z")), 11);
  assert.equal(gradeForClassOf(2028, new Date("2027-08-01T12:00:00Z")), 12);
  assert.equal(gradeForClassOf(2028, new Date("2028-09-01T00:00:00Z")), 12, "a graduated account stays 12");
  assert.equal(gradeForClassOf(2032, new Date("2026-10-01T00:00:00Z")), 9);
  assert.equal(classOfForGrade(13), null);

  const { db, auth } = store();
  auth.createStudentCredential("s1", "email-hash", "correct horse battery staple", { grade: 11 });
  const classOf = auth.getStudentClassOf("s1");
  assert.equal(classOf, classOfForGrade(11, new Date()));
  assert.equal(auth.getStudentGrade("s1"), 11);
  const septemberNextYear = new Date(Date.UTC(schoolYearStart(new Date()) + 1, 8, 1));
  assert.equal(auth.getStudentGrade("s1", septemberNextYear), 12);
  assert.equal(auth.getStudentGrade("missing"), null);
  assert.equal(auth.studentExists("s1"), true);
  assert.equal(auth.studentExists("missing"), false);
  // The sync's grade path writes the class along with the grade.
  assert.equal(auth.setStudentGrade("s1", 12), true);
  assert.equal(auth.getStudentClassOf("s1"), classOfForGrade(12, new Date()));
  assert.equal(auth.setStudentGrade("s1", 13), false);
  db.close();
});

test("an account from before class_of reads its class from its registration grade and date", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE student_credentials (
    student_id TEXT PRIMARY KEY,
    email_hash TEXT UNIQUE NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_kdf TEXT NOT NULL DEFAULT 'scrypt-v2',
    recovery_hash TEXT NOT NULL,
    grade INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const registered = Date.UTC(2026, 9, 1); // 2026-10-01, a junior
  db.prepare(`INSERT INTO student_credentials (student_id, email_hash, password_salt, password_hash, recovery_hash, grade, created_at, updated_at)
    VALUES ('legacy', 'legacy-email', 'salt', 'hash', 'recovery', 11, ?, ?)`).run(registered, registered);
  const auth = initAuthStore(db, { sessionTtlMs: 60_000 });
  assert.equal(db.prepare("SELECT class_of FROM student_credentials WHERE student_id = 'legacy'").get().class_of, 2028);
  assert.equal(auth.getStudentGrade("legacy", new Date("2027-08-01T00:00:00Z")), 12);
  assert.equal(auth.getStudentGrade("legacy", new Date("2027-05-01T00:00:00Z")), 11);
  // Running the migration again changes nothing.
  initAuthStore(db, { sessionTtlMs: 60_000 });
  assert.equal(db.prepare("SELECT class_of FROM student_credentials WHERE student_id = 'legacy'").get().class_of, 2028);
  db.close();
});

// ─── Session housekeeping (store-10) ────────────────────────────────────
test("the cleanup the hourly session job runs removes expired student and admin sessions only", () => {
  const db = new Database(":memory:");
  const auth = initAuthStore(db, { sessionTtlMs: 60_000 });
  auth.createStudentCredential("s1", "email-hash", "correct horse battery staple", { grade: 11 });
  const live = auth.issueStudentSession("email-hash", "s1");
  db.prepare("INSERT INTO session_tokens (token_hash, email_hash, student_id, expires_at, created_at) VALUES ('expired', 'email-hash', 's1', 1, 0)").run();
  const admin = auth.bootstrapAdmin("administrator password 123");
  db.prepare("INSERT INTO admin_sessions (token_hash, csrf_hash, expires_at, created_at) VALUES ('old-admin', 'x', 1, 0)").run();
  auth.cleanup();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM session_tokens WHERE token_hash = 'expired'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE token_hash = 'old-admin'").get().n, 0);
  assert.equal(auth.validateStudentSession(live).studentId, "s1");
  assert.equal(auth.validateAdminSession(admin.token), true);
  db.close();
});

test("the session schema and its sweep live in the auth store alone", async () => {
  const { readServerSource } = await import("./helpers/server-source.mjs");
  const fs = await import("node:fs");
  const SERVER = readServerSource();
  const AUTH = fs.readFileSync(new URL("../security/security-auth.js", import.meta.url), "utf8");
  assert.doesNotMatch(SERVER, /CREATE TABLE IF NOT EXISTS session_tokens/);
  assert.equal(AUTH.match(/CREATE TABLE IF NOT EXISTS session_tokens/g).length, 1);
  assert.doesNotMatch(SERVER, /validateTokenLegacy|sessionTokens|sessionStmts/);
  assert.match(SERVER, /registerJob\("session_cleanup", \(\) => authStore\.cleanup\(\)/);
});
