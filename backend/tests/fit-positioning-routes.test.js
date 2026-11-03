// tests/fit-positioning-routes.test.js — College Fit through
// POST /api/positioning/targets (and the double-check, the priorities
// matrix and the chat that quote it), for the audit's fit findings of
// 2026-11-03: a failed repository index (fit-3), a record with nothing in
// it (fit-4), no major (fit-1), a retaken SAT (fit-2), an unknown admit
// rate (fit-5), an unread test policy (fit-6), the matrix and the card
// agreeing (fit-8), stored and cached reads outliving their inputs (fit-9,
// debt-5). The server is spawned as in council-naming-deadlines-routes,
// with the mock's switch file (TEST_MOCK_SWITCHES) driving the CDS
// repository index and the College Scorecard.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { SCOUT_VERSION } from "../scouts/admissions-policy-scout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FETCH_MOCK = path.join(__dirname, "helpers", "mock-openrouter-fetch.mjs");

let baseUrl;
let callLogPath;
let switchesPath;
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

async function request(method, pathname, { body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

function setSwitches(value) {
  fs.writeFileSync(switchesPath, JSON.stringify(value), "utf8");
}

function loggedModelCalls() {
  if (!fs.existsSync(callLogPath)) return [];
  return fs.readFileSync(callLogPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

// A throwaway student with the three consents and the given profile.
async function student(label, { profile = {}, majorInterest = "Computer Science", register = {} } = {}) {
  const registered = await request("POST", "/api/students/register", {
    body: {
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: "correct horse battery staple",
      grade: 10,
      state: "CA",
      schoolDomain: "example.edu",
      ...register,
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const token = registered.data.token;
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", { token, body: { consentType, grantedBy: "student" } });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }
  await sync(token, { profile, majorInterest });
  return token;
}

async function sync(token, { profile = {}, majorInterest = "Computer Science" } = {}) {
  const synced = await request("POST", "/api/students/sync", {
    token,
    body: {
      profile: { courses: [], testScores: [], apScores: [], ...profile },
      activities: [],
      majorInterest,
      goals: [],
    },
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
}

async function fitRead(token, schoolName, body = {}) {
  const fit = await request("POST", "/api/positioning/targets", {
    token,
    body: { targets: [{ schoolName }], searchCds: false, ...body },
  });
  assert.equal(fit.status, 200, `${JSON.stringify(fit.data)}\n${serverOutput.slice(-4000)}`);
  return fit.data;
}

async function chatWire(token, question, requestId) {
  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      system: "You are the COLLEGE FIT specialist for students ages 14-18.",
      messages: [{ role: "user", content: `${question} MOCKREPLY:${b64("Here is where you stand.")}:` }],
      request_id: requestId,
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput.slice(-4000)}`);
  const calls = loggedModelCalls();
  return JSON.stringify(calls[calls.length - 1].messages);
}

const STRONG_PROFILE = {
  gpa: { unweighted: 3.85, weighted: 4.3 },
  courses: [{ name: "AP Calculus BC", type: "ap", grade: "A", year: "junior" }],
  testScores: [{ test: "sat", totalScore: 1480 }],
};

before(async () => {
  const port = await freePort();
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "college-counselor-route-tests-"));
  callLogPath = path.join(testDataDir, "openrouter-calls.jsonl");
  switchesPath = path.join(testDataDir, "mock-switches.json");
  // The repository index refuses the server from the start.
  setSwitches({ cdsIndex: 403 });
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
      ENCRYPTION_KEY: "ab".repeat(32),
      OPENROUTER_API_KEY: "sk-or-test-openrouter-key",
      SCORECARD_API_KEY: "test-scorecard-key",
      SIM_URL: `http://127.0.0.1:${port + 1}`,
      SIM_INTERNAL_TOKEN: "route-test-sidecar-token",
      TEST_OPENROUTER_CALL_LOG: callLogPath,
      TEST_MOCK_SWITCHES: switchesPath,
      // The index is read again on every request once it recovers.
      CDS_INDEX_FAILURE_MEMO_MS: "0",
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

// The index answering 403 used to make every uncached read a 500 and the
// card fall back to "Limited data for this school" for Columbia, whose
// validated CDS the store holds (fit-3).
test("a refused repository index still reads a stored school, and the degraded read is not cached", async () => {
  setSwitches({ cdsIndex: 403 });
  const token = await student("fit-index-down", { profile: STRONG_PROFILE });
  const first = await fitRead(token, "Columbia University", { major: "Computer Science" });
  assert.equal(first.modelVersion, "positioning_v3");
  assert.equal(first.degraded, true);
  assert.equal(first.cached, false);
  const read = first.targets[0];
  assert.ok(read.overallPositioningLabel, JSON.stringify(read));
  assert.equal(read.dataProvenance.kind, "cds_store");
  assert.ok(read.admitRateUsed > 0 && read.admitRateUsed < 0.05, `admit rate ${read.admitRateUsed}`);
  const second = await fitRead(token, "Columbia University", { major: "Computer Science" });
  assert.equal(second.cached, false, "a read built while the index was down is not kept");

  setSwitches({ cdsIndex: "throw" });
  const unreachable = await fitRead(token, "Columbia University", { major: "Computer Science" });
  assert.equal(unreachable.targets[0].dataProvenance.kind, "cds_store");

  // Recovered: the next read is whole, and it is cached.
  setSwitches({});
  const recovered = await fitRead(token, "Columbia University", { major: "Computer Science" });
  assert.equal(recovered.degraded, false);
  assert.equal(recovered.cached, false);
  const cached = await fitRead(token, "Columbia University", { major: "Computer Science" });
  assert.equal(cached.cached, true);
});

// A grade-10 student with nothing entered read "Reach" at most schools,
// and the chat was told to use that exact label (fit-4).
test("a record with no GPA and no SAT/ACT gets no label, and the chat is given none to quote", async () => {
  setSwitches({});
  const token = await student("fit-empty");
  const data = await fitRead(token, "Columbia University", { major: "Computer Science" });
  const read = data.targets[0];
  assert.equal(read.labelKey, "insufficient_student_data");
  assert.equal(read.overallPositioningLabel, "Not enough data yet");
  assert.equal(read.finalPositioningScore, null);
  assert.deepEqual(read.studentDataNeeded, ["gpa", "sat_or_act"]);
  assert.ok(read.profileComparison && read.profileComparison.tests, "the comparison block is kept");
  assert.equal(read.dataProvenance.labelKey, "insufficient_student_data");

  // This student's only read is the withheld one, so the chat carries no
  // fit line at all (the chat's own "no label yet" line is chat-grounding's).
  const wire = await chatWire(token, "How do I stand at Columbia University?", "fit-empty-chat-1");
  assert.doesNotMatch(wire, /College Fit read for THIS student/);
  assert.doesNotMatch(wire, /Not enough data yet/);
});

// No major used to be read as computer science: two coursework flags and a
// capped-major warning for a student who had chosen nothing (fit-1).
test("a student with no major gets no major-specific flags", async () => {
  setSwitches({});
  const courses = ["English 10", "World History", "Spanish II", "Biology", "Art", "Physical Education", "Algebra II", "Chemistry"]
    .map((name) => ({ name, type: "regular", grade: "A", year: "sophomore" }));
  const token = await student("fit-no-major", { profile: { gpa: { unweighted: 3.7 }, courses, testScores: [{ test: "sat", totalScore: 1250 }] }, majorInterest: "" });
  const data = await fitRead(token, "University of Michigan");
  assert.equal(data.major, null);
  const read = data.targets[0];
  assert.equal(read.intendedMajor, null);
  assert.ok(!read.mainRedFlags.some((f) => /Weak major-relevant coursework|capacity-constrained major/.test(f)), JSON.stringify(read.mainRedFlags));
  assert.notEqual(read.labelKey, "insufficient_student_data");
});

// The first SAT on file was the oldest sitting (fit-2).
test("a retaken SAT is read at its best sitting", async () => {
  setSwitches({});
  const token = await student("fit-retake", {
    profile: {
      gpa: { unweighted: 3.9 },
      testScores: [
        { test: "sat", totalScore: 1250, date: "2026-03" },
        { test: "sat", totalScore: 1530, date: "2026-10" },
      ],
    },
  });
  const read = (await fitRead(token, "Stanford University", { major: "Computer Science" })).targets[0];
  assert.equal(read.profileComparison.tests.used.score, 1530);
});

// A test policy nobody read was read as required: UCLA (test-blind) told a
// student with no score that tests are required or considered (fit-6).
test("an unread test policy is not read as required", async () => {
  setSwitches({});
  const token = await student("fit-ucla", { profile: { gpa: { unweighted: 3.9 } } });
  const read = (await fitRead(token, "University of California, Los Angeles", { major: "Biology" })).targets[0];
  assert.notEqual(read.profileComparison.tests.policy, "test_considered_or_required", JSON.stringify(read.profileComparison.tests));
  assert.equal(read.profileComparison.tests.score, 42);
  assert.notEqual(read.dataProvenance.testPolicy.bucket, "test_considered_or_required");
});

// Occidental's stored CDS has SAT bands but no admit rate and the school
// has no baseline row: the read started from an assumed 50% because the
// Scorecard fallback ran only when every field was missing (fit-5).
test("the Scorecard fills a missing admit rate field by field, and a school with nothing is 'none'", async () => {
  setSwitches({});
  const token = await student("fit-fill", { profile: STRONG_PROFILE });
  const read = (await fitRead(token, "Occidental College", { major: "Computer Science" })).targets[0];
  assert.equal(read.admitRateUsed, 0.49, JSON.stringify(read.admitRate));
  assert.equal(read.dataProvenance.fieldSources.acceptance_rate, "college_scorecard");
  assert.equal(read.dataProvenance.fieldSources.sat_range, "cds_store", "the CDS band is kept");
  assert.equal(read.dataProvenance.kind, "cds_store");

  // Nothing held and the Scorecard failing: no source is claimed, the rate
  // is unknown and said to be, and the read is not cached.
  setSwitches({ scorecard: "fail" });
  const nowhere = await fitRead(token, "Zzyzx Mountain College of Testing", { major: "Computer Science" });
  const unknown = nowhere.targets[0];
  assert.equal(unknown.dataProvenance.kind, "none");
  assert.equal(unknown.admitRate.used, null);
  assert.equal(unknown.admitRate.assumedForLikelihood, 0.5);
  assert.equal(nowhere.degraded, true);
  assert.equal((await fitRead(token, "Zzyzx Mountain College of Testing", { major: "Computer Science" })).cached, false);
  setSwitches({});
});

function seedPolicySnapshot(slug, school, value, evidence, sourceUrl) {
  const db = new Database(path.join(testDataDir, "operational.db"));
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT OR REPLACE INTO admissions_policy_snapshots (slug, school_name, unit_id, homepage, checked_at, changed_at, content_hash, pages_json, policy_json, check_count)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 1)`).run(
      slug, school, "https://www.example.edu/", now, now, `hash-${slug}-${value}`, "[]",
      JSON.stringify({ cycle: "2026-27", scoutVersion: SCOUT_VERSION, testPolicy: { value, through: null, evidence, sourceUrl }, applicationFee: null, deadlines: {} }),
    );
  } finally {
    db.close();
  }
}

// A policy the scout corrected kept its old red flag on a cached read for up
// to a week (debt-5); a double-check stayed beside a newer read, and a read
// from an older profile kept its label in the chat (fit-9).
test("a cached read follows the policy scout, and a stored read follows the profile", async () => {
  setSwitches({});
  const token = await student("fit-cache", { profile: STRONG_PROFILE });
  const first = await fitRead(token, "Stanford University", { major: "Computer Science" });
  assert.equal(first.cached, false);
  assert.equal((await fitRead(token, "Stanford University", { major: "Computer Science" })).cached, true);
  seedPolicySnapshot("stanford-university", "Stanford University", "test_required", "Stanford requires the SAT or ACT of first-year applicants.", "https://admission.stanford.edu/apply/testing");
  const afterScout = await fitRead(token, "Stanford University", { major: "Computer Science" });
  assert.equal(afterScout.cached, false, "a new scout reading recomputes the read");
  assert.equal(afterScout.targets[0].profileComparison.tests.stated?.value, "test_required");

  // The double-check is stored beside this read and reaches the chat.
  const verify = await request("POST", "/api/positioning/verify", { token, body: { schoolName: "Stanford University", major: "Computer Science" } });
  assert.equal(verify.status, 200, `${JSON.stringify(verify.data)}\n${serverOutput.slice(-4000)}`);
  const withVerdict = await chatWire(token, "How do I stand at Stanford University?", "fit-cache-chat-1");
  assert.match(withVerdict, /College Fit read for THIS student/);
  assert.match(withVerdict, /College Fit double-check \(/);

  // A profile edit: the stored read is from an older snapshot, so the chat
  // is given no label until College Fit is read again.
  await sync(token, { profile: { ...STRONG_PROFILE, testScores: [{ test: "sat", totalScore: 1500 }] } });
  const staleWire = await chatWire(token, "How do I stand at Stanford University?", "fit-cache-chat-2");
  assert.doesNotMatch(staleWire, /College Fit read for THIS student/);
  assert.doesNotMatch(staleWire, /College Fit double-check \(/);

  // Read again: the label is back, the old double-check is not, and the
  // double-check itself is not answered from the older read's cache.
  await fitRead(token, "Stanford University", { major: "Computer Science" });
  const freshWire = await chatWire(token, "How do I stand at Stanford University?", "fit-cache-chat-3");
  assert.match(freshWire, /College Fit read for THIS student/);
  assert.doesNotMatch(freshWire, /College Fit double-check \(/);
  const reverify = await request("POST", "/api/positioning/verify", { token, body: { schoolName: "Stanford University", major: "Computer Science" } });
  assert.equal(reverify.status, 200);
  assert.equal(reverify.data.cached, false);
});

// The matrix under the card used to build its own school context, with no
// stated policy: at Dartmouth (CDS test-optional, its pages require scores)
// it said "consider withholding" beside a card that treated scores as
// required (fit-8).
test("the priorities matrix reads the school as the card does", async () => {
  setSwitches({});
  seedPolicySnapshot("dartmouth-college", "Dartmouth College", "test_required", "Dartmouth requires the SAT or ACT of first-year applicants.", "https://admissions.dartmouth.edu/apply/testing");
  const token = await student("fit-matrix", { profile: { gpa: { unweighted: 3.9 }, testScores: [{ test: "sat", totalScore: 1300 }] } });
  const card = (await fitRead(token, "Dartmouth College", { major: "Computer Science" })).targets[0];
  assert.equal(card.profileComparison.tests.policy, "test_considered_or_required");
  assert.equal(card.profileComparison.tests.advice, "submit");
  const values = await request("POST", "/api/colleges/values", { token, body: { collegeName: "Dartmouth College" } });
  assert.equal(values.status, 200, `${JSON.stringify(values.data)}\n${serverOutput.slice(-4000)}`);
  const testItem = (values.data.fit?.academics || []).find((item) => item.kind === "test");
  assert.ok(testItem, JSON.stringify(values.data.fit?.academics));
  assert.notEqual(testItem.advice, "withhold", "the matrix no longer advises withholding a score the school requires");
  assert.equal(testItem.position, card.profileComparison.tests.used.position);
});
