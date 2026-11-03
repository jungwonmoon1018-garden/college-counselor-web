// Route tests for the student data store: the profile revision and its 409,
// an unchanged sync, a cleared score leaving the context bundle, the export
// in plaintext, consent withdrawal and the consent gate on every paid path,
// evidence removal, and account erasure leaving nothing behind.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { hashEmail as hashPIIEmail } from "../storage/pii-vault.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FETCH_MOCK = path.join(__dirname, "helpers", "mock-openrouter-fetch.mjs");
const ENCRYPTION_KEY = "ab".repeat(32);

let baseUrl;
let callLogPath;
let serverOutput = "";
let serverProcess;
let testDataDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (serverProcess?.exitCode != null) {
      throw new Error(`Route-test server exited early (${serverProcess.exitCode}).\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for route-test server.\n${serverOutput}`);
}

async function request(method, pathname, { body, token, form } = {}) {
  const headers = {};
  if (!form) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

async function registerStudent(label) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = "correct horse battery staple";
  const result = await request("POST", "/api/students/register", {
    body: { email, password, grade: 11, majorInterest: "Computer Science" },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return { email, password, token: result.data.token, studentId: result.data.studentId };
}

async function grant(token, types = ["data_processing", "ai_interaction", "cross_border_transfer"]) {
  for (const consentType of types) {
    const granted = await request("POST", "/api/consent/grant", { token, body: { consentType, grantedBy: "student" } });
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
  }
}

function loggedModelCalls() {
  if (!fs.existsSync(callLogPath)) return [];
  return fs.readFileSync(callLogPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function openDb(name) {
  return new Database(path.join(testDataDir, name), { readonly: true, fileMustExist: true });
}

const ACTIVITY = "Seoul Youth Mental Health Peer Line";
const syncBody = ({ gpa = 3.62, sat = 1450, activities = [{ name: ACTIVITY, role: "Founder", category: "Service" }] } = {}) => ({
  profile: {
    gpa: gpa == null ? null : { unweighted: gpa },
    courses: [{ name: "AP Biology", type: "ap", grade: "A", year: "junior" }],
    testScores: sat ? [{ test: "sat", totalScore: sat }] : [],
    apScores: [],
  },
  activities,
  goals: [],
  majorInterest: "Computer Science",
});

before(async () => {
  const port = await freePort();
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "college-counselor-route-tests-"));
  callLogPath = path.join(testDataDir, "openrouter-calls.jsonl");
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["--import", pathToFileURL(FETCH_MOCK).href, "server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      RATE_LIMIT_RELAXED: "1",
      DATA_DIR: testDataDir,
      DB_PATH: path.join(testDataDir, "operational.db"),
      ENCRYPTION_KEY,
      OPENROUTER_API_KEY: "sk-or-test-openrouter-key",
      SCORECARD_API_KEY: "test-scorecard-key",
      SIM_URL: `http://127.0.0.1:${port + 1}`,
      SIM_INTERNAL_TOKEN: "route-test-sidecar-token",
      TEST_OPENROUTER_CALL_LOG: callLogPath,
      // The erasure's follow-up sweep, shortened so the test sees it run.
      ERASURE_RESWEEP_MS: "400",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  serverProcess.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  await waitForHealth();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode == null) {
    serverProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => serverProcess.once("exit", resolve)),
      delay(5_000),
    ]);
    if (serverProcess.exitCode == null) serverProcess.kill("SIGKILL");
  }
  const resolved = testDataDir ? path.resolve(testDataDir) : "";
  const expectedRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(expectedRoot) && path.basename(resolved).startsWith("college-counselor-route-tests-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("the profile revision moves only with a stored snapshot, and a stale base revision gets a 409 with the stored profile", async () => {
  const { token } = await registerStudent("revision");
  const initial = await request("GET", "/api/students/profile", { token });
  assert.equal(initial.status, 200);
  assert.equal(typeof initial.data.revision, "string");

  const first = await request("POST", "/api/students/sync", { token, body: syncBody() });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.unchanged, false);
  assert.notEqual(first.data.revision, initial.data.revision);

  // The same body again: nothing is stored and the revision holds.
  const same = await request("POST", "/api/students/sync", { token, body: { ...syncBody(), trigger: "auto_sync" } });
  assert.equal(same.status, 200);
  assert.equal(same.data.unchanged, true);
  assert.deepEqual(same.data.changes, []);
  assert.equal(same.data.revision, first.data.revision);
  const afterSame = await request("GET", "/api/students/profile", { token });
  assert.equal(afterSame.data.revision, first.data.revision);

  // A device holding the registration-time copy tries to save over it.
  const stale = await request("POST", "/api/students/sync", { token, body: { ...syncBody({ gpa: 3.1, sat: 1200 }), baseRevision: initial.data.revision } });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.code, "profile_revision_conflict");
  assert.equal(stale.data.revision, first.data.revision);
  assert.deepEqual(Object.keys(stale.data.profile).sort(), Object.keys(afterSame.data.profile).sort());
  assert.equal(stale.data.profile.gpa.unweighted, 3.62);
  const untouched = await request("GET", "/api/students/profile", { token });
  assert.equal(untouched.data.revision, first.data.revision);
  assert.equal(untouched.data.profile.gpa.unweighted, 3.62);

  // With the current revision the save lands and the revision moves.
  const current = await request("POST", "/api/students/sync", { token, body: { ...syncBody({ gpa: 3.7 }), baseRevision: first.data.revision } });
  assert.equal(current.status, 200, JSON.stringify(current.data));
  assert.notEqual(current.data.revision, first.data.revision);
  const latest = await request("GET", "/api/students/profile", { token });
  assert.equal(latest.data.revision, current.data.revision);
  assert.equal(latest.data.profile.gpa.unweighted, 3.7);
});

test("a cleared SAT leaves the context bundle the in-product skill reads", async () => {
  const { token } = await registerStudent("cleared-sat");
  assert.equal((await request("POST", "/api/students/sync", { token, body: syncBody({ sat: 1600 }) })).status, 200);
  const withSat = await request("GET", "/api/context/bundle", { token });
  assert.equal(withSat.status, 200, JSON.stringify(withSat.data));
  assert.match(JSON.stringify(withSat.data), /sat_total/);
  assert.equal((await request("POST", "/api/students/sync", { token, body: syncBody({ sat: null }) })).status, 200);
  const cleared = await request("GET", "/api/context/bundle", { token });
  assert.equal(cleared.status, 200);
  const student = cleared.data.rag.studentContext;
  // The percentile metrics, the text summary the skill cites, and the
  // structured read. (The trajectory row under vectors.directionality keeps
  // its own copy of the score, which its upsert does not refresh; that is
  // academics/directionality-vectorizer.js, reported separately.)
  assert.doesNotMatch(JSON.stringify(student.metrics), /sat_total/);
  assert.doesNotMatch(student.textSummary, /sat_total/);
  assert.equal(student.structuredData.metrics.sat_total, undefined);
  assert.equal(student.structuredData.profile.satTotal, null);
  assert.match(JSON.stringify(student.metrics), /gpa_uw/);
});

test("the export hands the student their conversations in plaintext", async () => {
  const { token } = await registerStudent("export");
  const thread = await request("POST", "/api/students/threads", { token, body: {} });
  assert.equal(thread.status, 200);
  const question = "Should I apply ED to Columbia or Cornell?";
  const answer = "Early decision is binding, so apply ED only where you would enroll if admitted, and run both net price calculators first so the cost is clear before you commit to either school.";
  assert.equal((await request("POST", `/api/students/threads/${thread.data.id}/messages`, { token, body: { role: "user", content: question } })).status, 200);
  assert.equal((await request("POST", `/api/students/threads/${thread.data.id}/messages`, { token, body: { role: "assistant", content: answer } })).status, 200);

  const exported = await request("GET", "/api/students/export", { token });
  assert.equal(exported.status, 200);
  const strings = [];
  const walk = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(exported.data);
  assert.deepEqual(strings.filter((s) => s.startsWith("enc:v1:")), []);
  const contents = exported.data.operational.chat_messages.map((m) => m.content);
  assert.ok(contents.includes(question));
  assert.ok(contents.includes(answer));
  assert.equal(exported.data.operational.chat_threads[0].title, question);
  assert.ok(exported.data.operational.chat_graph_facts.some((f) => f.question === question));
});

test("every paid path checks consent, and a withdrawn consent stops AI features until it is granted again", async () => {
  const { token } = await registerStudent("consent-gate");
  await grant(token, ["data_processing"]);
  assert.equal((await request("POST", "/api/students/sync", { token, body: syncBody() })).status, 200);
  const callsBefore = loggedModelCalls().length;

  const draft = await request("POST", "/api/narrative/draft", { token, body: {} });
  assert.equal(draft.status, 403, JSON.stringify(draft.data));
  assert.equal(draft.data.code, "consent_required");
  assert.ok(draft.data.missing.includes("ai_interaction"));
  const ideas = await request("POST", "/api/ec/ideas/generate", { token, body: {} });
  assert.equal(ideas.status, 403, JSON.stringify(ideas.data));
  assert.equal(ideas.data.code, "consent_required");
  // A sync that adds an activity triggers the background auto-narrative,
  // which used to send the profile out without asking.
  assert.equal((await request("POST", "/api/students/sync", { token, body: syncBody({ activities: [{ name: ACTIVITY, role: "Founder" }, { name: "Robotics Club", role: "Captain" }] }) })).status, 200);
  await delay(500);
  assert.equal(loggedModelCalls().length, callsBefore, "no model call without consent");
  const budget = await request("GET", "/api/students/budget", { token });
  assert.equal(budget.data.committedUsd, 0);

  // Positive control: with all three granted the same route reaches the model.
  await grant(token, ["ai_interaction", "cross_border_transfer"]);
  const granted = await request("POST", "/api/narrative/draft", { token, body: {} });
  assert.notEqual(granted.status, 403, JSON.stringify(granted.data));
  assert.ok(loggedModelCalls().length > callsBefore);

  // Withdrawal: reported as revoked (and missing), and every AI path refuses.
  const revoke = await request("POST", "/api/consent/revoke", { token, body: { consentType: "ai_interaction" } });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.data));
  assert.equal(revoke.data.revoked, true);
  const status = await request("GET", "/api/consent/status", { token });
  assert.deepEqual(status.data.revoked, ["ai_interaction"]);
  assert.ok(status.data.missing.includes("ai_interaction"));
  const callsAtRevoke = loggedModelCalls().length;
  const chat = await request("POST", "/api/chat", { token, body: { request_id: crypto.randomUUID(), messages: [{ role: "user", content: "Which AP classes should I take next year?" }] } });
  assert.equal(chat.status, 403, JSON.stringify(chat.data));
  const draftAfter = await request("POST", "/api/narrative/draft", { token, body: {} });
  assert.equal(draftAfter.status, 403);
  assert.equal(draftAfter.data.code, "consent_required");
  assert.equal(loggedModelCalls().length, callsAtRevoke);

  const bad = await request("POST", "/api/consent/revoke", { token, body: { consentType: "everything" } });
  assert.equal(bad.status, 400);

  // Granting again clears the withdrawal.
  await grant(token, ["ai_interaction"]);
  const regranted = await request("GET", "/api/consent/status", { token });
  assert.deepEqual(regranted.data.revoked, []);
  assert.deepEqual(regranted.data.missing, []);

  // The audit row names the type, nothing else.
  const db = openDb("operational.db");
  try {
    const row = db.prepare("SELECT details FROM audit_events WHERE type = 'consent_revoked' ORDER BY timestamp DESC LIMIT 1").get();
    assert.equal(row.details, "ai_interaction by student");
  } finally {
    db.close();
  }
});

async function upload(token, ecName, text, filename = "award.txt") {
  const form = new FormData();
  form.append("ec_name", ecName);
  form.append("file", new Blob([text], { type: "text/plain" }), filename);
  return request("POST", "/api/ec/upload", { token, form });
}

async function citedAttachmentIds(token, ecName) {
  const r = await request("GET", `/api/ec/strength/${encodeURIComponent(ecName)}`, { token });
  return r.status === 200 ? (r.data.attachments || []).map((a) => a.id) : [];
}

test("a direct upload is sealed at rest, and the student can remove it", async () => {
  const owner = await registerStudent("evidence-owner");
  const stranger = await registerStudent("evidence-stranger");
  assert.equal((await request("POST", "/api/students/sync", { token: owner.token, body: syncBody({ activities: [{ name: "Robotics Club", role: "Captain", category: "STEM" }] }) })).status, 200);

  const uploaded = await upload(owner.token, "Robotics Club", "Robotics Club regional championship award certificate, first place, 2026 season.");
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const id = uploaded.data.attachment_id;
  let cited = [];
  for (let i = 0; i < 40 && !cited.includes(id); i += 1) { await delay(100); cited = await citedAttachmentIds(owner.token, "Robotics Club"); }
  assert.ok(cited.includes(id), "the strength read cites the upload");

  const db = openDb("operational.db");
  let storagePath;
  try {
    const row = db.prepare("SELECT extracted_text, storage_path FROM ec_attachments WHERE id = ?").get(id);
    assert.match(row.extracted_text, /^enc:v1:/);
    storagePath = row.storage_path;
  } finally {
    db.close();
  }
  assert.ok(fs.existsSync(storagePath));

  const notYours = await request("DELETE", `/api/ec/attachments/${id}`, { token: stranger.token });
  assert.equal(notYours.status, 404);
  assert.ok(fs.existsSync(storagePath));

  const removed = await request("DELETE", `/api/ec/attachments/${id}`, { token: owner.token });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.fileRemoved, true);
  assert.equal(fs.existsSync(storagePath), false);
  assert.equal((await citedAttachmentIds(owner.token, "Robotics Club")).includes(id), false);
  const again = await request("DELETE", `/api/ec/attachments/${id}`, { token: owner.token });
  assert.equal(again.status, 404);
  const check = openDb("operational.db");
  try {
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM ec_attachments WHERE id = ?").get(id).n, 0);
  } finally {
    check.close();
  }
});

// Every table in a database with a column that can hold the student's id or
// email hash, and the rows in it that do.
function inventory(file, needles) {
  const db = openDb(file);
  const keyColumns = new Set(["student_id", "email_hash", "extracted_by_student_id", "entity_id", "source_id", "user_hint", "student_hint", "recipient_email_hash"]);
  const scanned = [];
  const hits = [];
  try {
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name).filter((c) => keyColumns.has(c));
      if (columns.some((c) => c === "student_id" || c === "email_hash")) scanned.push(name);
      for (const column of columns) {
        for (const needle of needles) {
          const n = db.prepare(`SELECT COUNT(*) AS n FROM "${name}" WHERE "${column}" = ?`).get(needle).n;
          if (n) hits.push(`${file}:${name}.${column} x${n}`);
        }
      }
    }
  } finally {
    db.close();
  }
  return { scanned, hits };
}

test("deleting the account leaves no row, audit hint or file of the student in any database", async () => {
  const student = await registerStudent("erasure");
  await grant(student.token);
  assert.equal((await request("POST", "/api/students/sync", { token: student.token, body: syncBody() })).status, 200);
  const thread = await request("POST", "/api/students/threads", { token: student.token, body: {} });
  await request("POST", `/api/students/threads/${thread.data.id}/messages`, { token: student.token, body: { role: "user", content: `How do I describe ${ACTIVITY} in my application?` } });
  await request("POST", `/api/students/threads/${thread.data.id}/messages`, { token: student.token, body: { role: "assistant", content: "Lead with what you built: who the line serves, how many volunteers you trained, and what changed because it exists. Keep the description concrete and in your own words." } });
  const uploaded = await upload(student.token, ACTIVITY, `${ACTIVITY} founder recognition letter from the district.`);
  assert.equal(uploaded.status, 200);
  await delay(300);

  const emailHash = crypto.createHash("sha256").update(`email_salt_cc:${student.email}`).digest("hex");
  const needles = [student.studentId, emailHash, emailHash.slice(0, 12), student.studentId.slice(0, 12), hashPIIEmail(student.email, ENCRYPTION_KEY)];
  const beforeHits = ["operational.db", "pii-vault.db", "vectors.db"].flatMap((f) => inventory(f, needles).hits);
  assert.ok(beforeHits.length > 5, `the inventory sees the student's rows before the delete: ${beforeHits.join(", ")}`);
  assert.ok(fs.existsSync(path.join(testDataDir, "ec-attachments", student.studentId)));

  const deleted = await request("DELETE", "/api/students", { token: student.token });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  // The account ends at once: the session is dead and the login fails.
  assert.equal((await request("GET", "/api/students/profile", { token: student.token })).status, 401);
  const login = await request("POST", "/api/students/auth", { body: { email: student.email, password: student.password } });
  assert.equal(login.status, 401);

  // Late background work, then the follow-up sweep.
  await delay(1200);
  const scannedTables = new Set();
  const afterHits = [];
  for (const file of ["operational.db", "pii-vault.db", "vectors.db"]) {
    const { scanned, hits } = inventory(file, needles);
    scanned.forEach((t) => scannedTables.add(t));
    afterHits.push(...hits);
  }
  assert.deepEqual(afterHits, []);
  for (const table of ["profile_snapshots", "capability_timeline", "milestones", "chat_threads", "ec_attachments", "consent_records", "students_pii", "student_credentials", "session_tokens", "usage_budget_reservations"]) {
    assert.ok(scannedTables.has(table), `${table} was inventoried`);
  }
  const db = openDb("operational.db");
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?").get(thread.data.id).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE details LIKE ?").get(`%${ACTIVITY}%`).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type = 'student_data_deleted'").get().n >= 1, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM erasure_tombstones").get().n >= 1, true);
  } finally {
    db.close();
  }
  assert.equal(fs.existsSync(path.join(testDataDir, "ec-attachments", student.studentId)), false);
});
