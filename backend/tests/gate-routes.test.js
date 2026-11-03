// Route tests for the topic gate and its grounding (wave 2, "gate"): Korean
// lookups reach the official-source gate, a FAFSA question about the
// student's own situation reaches the model with the reviewed rule text,
// the model is told the student's grade level, a named school with nothing
// held is said to be unheld, and the admin status carries the FAFSA ruleset
// clock. The server runs with the mock OpenRouter transport, so nothing
// leaves the machine.
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
import { FAFSA_RULESETS, selectFafsaRuleset } from "../chat/rules-engine.js";
import { expandCollegeAlias, slugifyCollege } from "../colleges/college-research.js";
import { planningCycle, planningCycleStartYear } from "../shared/admissions-cycle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FETCH_MOCK = path.join(__dirname, "helpers", "mock-openrouter-fetch.mjs");

let baseUrl;
let callLogPath;
let dbPath;
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

async function request(method, pathname, { body, token, headers: extra = {} } = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function registerStudent(label, grade = 11) {
  const result = await request("POST", "/api/students/register", {
    body: {
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: "correct horse battery staple",
      grade,
      state: "CA",
      schoolDomain: "example.edu",
      majorInterest: "Computer Science",
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const token = result.data.token;
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", { token, body: { consentType, grantedBy: "student" } });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }
  return token;
}

function loggedModelCalls() {
  if (!fs.existsSync(callLogPath)) return [];
  return fs.readFileSync(callLogPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

// The system text of the model call whose messages carry `marker`.
function systemTextFor(marker) {
  const calls = loggedModelCalls().filter((call) => JSON.stringify(call.messages).includes(marker));
  assert.ok(calls.length, `no model call carried ${marker}`);
  const first = calls[0].messages[0];
  return String(first?.content?.[0]?.text || first?.content || "");
}

async function chat(token, content, requestId, headers = {}) {
  const turn = await request("POST", "/api/chat", {
    token,
    headers,
    body: { messages: [{ role: "user", content }], request_id: requestId },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput.slice(-3000)}`);
  return turn.data;
}

before(async () => {
  const port = await freePort();
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "college-counselor-route-tests-"));
  callLogPath = path.join(testDataDir, "openrouter-calls.jsonl");
  dbPath = path.join(testDataDir, "operational.db");
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["--import", pathToFileURL(FETCH_MOCK).href, "server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      RATE_LIMIT_RELAXED: "1",
      DATA_DIR: testDataDir,
      DB_PATH: dbPath,
      ENCRYPTION_KEY: "ab".repeat(32),
      OPENROUTER_API_KEY: "sk-or-test-openrouter-key",
      SCORECARD_API_KEY: "test-scorecard-key",
      SIM_URL: `http://127.0.0.1:${port + 1}`,
      SIM_INTERNAL_TOKEN: "route-test-sidecar-token",
      TEST_OPENROUTER_CALL_LOG: callLogPath,
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
    await Promise.race([new Promise((resolve) => serverProcess.once("exit", resolve)), delay(5_000)]);
    if (serverProcess.exitCode == null) serverProcess.kill("SIGKILL");
  }
  const resolved = testDataDir ? path.resolve(testDataDir) : "";
  const expectedRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(expectedRoot) && path.basename(resolved).startsWith("college-counselor-route-tests-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

// gate-12: a Korean deadline lookup was ordinary coaching, with no advisory
// prefix, no on-demand read and no VERIFIED DATA for a Hangul school name.
test("a Korean deadline lookup goes through the official-source gate like the English one", async () => {
  const token = await registerStudent("gate-ko");
  const korean = "스탠퍼드 조기 지원 마감일이 언제예요?";
  const reply = await chat(token, korean, "gate-ko-1", { "X-CollegeApp-Locale": "ko" });
  if (reply._meta?.deterministic) {
    // Nothing held for the school after the on-demand read: the Korean
    // no-source reply, never a guessed date.
    assert.match(String(reply.answer), /스탠퍼드|Stanford/);
    assert.match(String(reply.answer), /공식 입학처|공식 페이지/);
  } else {
    const system = systemTextFor(korean);
    assert.match(system, /This is a high-stakes topic/);
    assert.match(system, /VERIFIED DATA[\s\S]*Stanford University/);
  }
  // The on-demand read of the school's own pages was tried first (the mock
  // refuses every school host, so it fails); the turn's timings carry it.
  const tried = reply._meta?.onDemandRead ?? reply._meta?.timings?.on_demand_read;
  assert.ok(tried != null, `no on-demand read: ${JSON.stringify(reply._meta)}`);

  // Ordinary Korean counseling gets no advisory prefix.
  const essay = "에세이 주제 추천해 주세요";
  await chat(token, essay, "gate-ko-2", { "X-CollegeApp-Locale": "ko" });
  assert.doesNotMatch(systemTextFor(essay), /This is a high-stakes topic|This is a regulated topic/);
});

// The dates-only answer from the research cache fits a pure deadline lookup.
// Its exclusion list was English, so once the router heard Korean deadline
// questions, one that also asked about the testing policy got the dates and
// nothing else. Both directions, with official dates cached for the cycle
// the server plans for (the same function the route reads them under).
test("a Korean deadline question that also asks about policy is not answered from the dates-only cache", async () => {
  const token = await registerStudent("gate-ko-cache");
  const cycle = planningCycle(new Date());
  const start = planningCycleStartYear(new Date());
  const slug = slugifyCollege(expandCollegeAlias("Stanford University"));
  const fetchedAt = new Date().toISOString();
  const record = {
    displayName: "Stanford University",
    slug,
    cycle,
    deadlines: { ea: `${start}-11-01`, ed: null, edII: null, rd: `${start + 1}-01-05`, financialAid: null, commitBy: null, decisionRelease: null },
    sourceUrl: "https://admission.stanford.edu/apply/",
    extractedAt: fetchedAt,
  };
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("INSERT OR REPLACE INTO college_research_cache (cache_key, kind, slug, display_name, payload_json, fetched_at) VALUES (?, 'deadlines', ?, ?, ?, ?)")
      .run(`deadlines:${slug}:${cycle}`, slug, record.displayName, JSON.stringify(record), fetchedAt);
  } finally {
    db.close();
  }

  const dates = await chat(token, "스탠퍼드 조기 지원 마감일이 언제예요?", "gate-ko-cache-1", { "X-CollegeApp-Locale": "ko" });
  assert.equal(dates._meta?.deterministic, true, JSON.stringify(dates));
  assert.ok(JSON.stringify(dates).includes(`${start}-11-01`), JSON.stringify(dates).slice(0, 800));

  const withPolicy = "스탠퍼드 조기 지원 마감일 언제예요? 시험 정책도요";
  const reply = await chat(token, withPolicy, "gate-ko-cache-2", { "X-CollegeApp-Locale": "ko" });
  assert.equal(reply._meta?.deterministic, false, JSON.stringify(reply).slice(0, 800));
  assert.match(systemTextFor(withPolicy), /VERIFIED DATA[\s\S]*Stanford University/);
  // The block it reached the model with held Stanford's data.
  assert.equal(reply._meta.verifiedData, true);
});

// gate-9: a FAFSA question about the student's own situation got "6
// eligibility item(s) have not been confirmed yet" and nothing about it.
test("a FAFSA question about the student's situation reaches the model with the reviewed rules", async () => {
  const token = await registerStudent("gate-fafsa");
  const question = "Am I eligible for FAFSA as a permanent resident?";
  const reply = await chat(token, question, "gate-fafsa-1");
  assert.equal(reply._meta?.deterministic, false);
  assert.doesNotMatch(String(reply.answer), /eligibility item\(s\) have not been confirmed/);
  const system = systemTextFor(question);
  assert.match(system, /This is a regulated topic/);
  // The rule text rides along only while a reviewed ruleset covers today;
  // after that the advisory prefix and the StudentAid.gov pointer stand alone.
  if (selectFafsaRuleset(new Date())) {
    assert.match(system, /OFFICIAL FAFSA ELIGIBILITY RULES/);
    assert.match(system, /permanent resident with Green Card/);
  } else {
    assert.doesNotMatch(system, /OFFICIAL FAFSA ELIGIBILITY RULES/);
  }

  // A plain checklist question stays on the rules engine while a ruleset
  // covers the date, with each rule a verified, sourced fact.
  const checklist = await request("POST", "/api/chat", {
    token,
    body: { messages: [{ role: "user", content: "What are the FAFSA eligibility requirements?" }], request_id: "gate-fafsa-2" },
  });
  assert.equal(checklist.status, 200, JSON.stringify(checklist.data));
  if (selectFafsaRuleset(new Date())) {
    assert.equal(checklist.data._meta.deterministic, true);
    assert.ok(checklist.data.verified_facts.length >= 5);
    assert.match(checklist.data.answer, /basic requirements for federal student aid/);
  } else {
    assert.equal(checklist.data._meta.deterministic, false);
  }
});

// fid-5: the model could not tell a freshman from a senior.
test("the model is told the student's grade level from the server's record", async () => {
  const token = await registerStudent("gate-grade", 12);
  const synced = await request("POST", "/api/students/sync", {
    token,
    body: { profile: { gpa: { unweighted: 3.7 }, courses: [], testScores: [] }, activities: [], majorInterest: "Biology", goals: [] },
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  const question = "What should I focus on this month for my applications?";
  await chat(token, question, "gate-grade-1");
  assert.match(systemTextFor(question), /STUDENT PROFILE[^\n]*\nGrade level: 12th grade \(senior\)\n/);
});

// fid-10: a named school with nothing held left the block silent, and the
// model answered from memory.
test("a college the question names that nothing is held for is said to be unheld", async () => {
  const token = await registerStudent("gate-unheld");
  const question = "What is Elm Valley College's acceptance rate?";
  const reply = await chat(token, question, "gate-unheld-1");
  assert.match(systemTextFor(question), /- Elm Valley College: no verified data held/);
  // A block that only says so is not held data: _meta.verifiedData used to
  // report true for any block at all.
  assert.equal(reply._meta?.verifiedData, false, JSON.stringify(reply._meta));
});

// time-4: the counselor is told before the FAFSA ruleset lapses.
test("the admin status carries the FAFSA ruleset clock", async () => {
  const status = await request("GET", "/api/admin/status");
  assert.equal(status.status, 200, JSON.stringify(status.data));
  const { fafsaRulesets } = status.data;
  assert.ok(fafsaRulesets && Array.isArray(fafsaRulesets.rulesets));
  assert.equal(fafsaRulesets.rulesets.length, FAFSA_RULESETS.length);
  const now = Date.now();
  for (const row of fafsaRulesets.rulesets) {
    const expected = Math.ceil((Date.parse(row.expiresAt) - now) / (24 * 60 * 60 * 1000));
    assert.ok(Math.abs(row.daysLeft - expected) <= 1, `${row.id} daysLeft ${row.daysLeft} vs ${expected}`);
  }
  assert.ok(fafsaRulesets.warning === null || typeof fafsaRulesets.warning === "string");
});
