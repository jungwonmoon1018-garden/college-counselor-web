// /api/chat reliability, end to end against the spawned server and the mock
// OpenRouter: an unusable reply is retried once and then answered with a
// coded 502, an upstream 401 never leaves as our own 401, a utility call
// gets the model's JSON back undecorated, a client that goes away stops the
// provider call, and the fidelity retry is not started past the turn's
// retry cutoff.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FETCH_MOCK = path.join(__dirname, "helpers", "mock-openrouter-fetch.mjs");
// The server's retry cutoff for this file. The fidelity test delays its first
// reply past it; every other turn here answers well inside it.
const RETRY_CUTOFF_MS = 4000;

let baseUrl;
let callLogPath;
let dbPath;
let serverOutput = "";
let serverProcess;
let testDataDir;

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

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

async function request(method, pathname, { body, token, headers = {}, signal } = {}) {
  const allHeaders = { "Content-Type": "application/json", ...headers };
  if (token) allHeaders.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: allHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
}

async function registerStudent(label) {
  const result = await request("POST", "/api/students/register", {
    body: {
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: "correct horse battery staple",
      grade: 11,
      state: "CA",
      schoolDomain: "example.edu",
      majorInterest: "Computer Science",
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.token;
}

async function grantConsents(token) {
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", { token, body: { consentType, grantedBy: "student" } });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }
}

async function registerWithProfile(label) {
  const token = await registerStudent(label);
  await grantConsents(token);
  const synced = await request("POST", "/api/students/sync", {
    token,
    body: {
      profile: {
        gpa: { unweighted: 3.82, weighted: 4.31 },
        courses: [
          { name: "English Language and Composition", type: "ap", grade: "B+", year: "junior" },
          { name: "Statistics", type: "ap", grade: "A", year: "junior" },
        ],
        testScores: [{ test: "sat", totalScore: 1450 }],
      },
      activities: [{ name: "Robotics Club", role: "Captain", category: "robotics", hoursPerWeek: 8 }],
      majorInterest: "Computer Science",
      goals: [],
    },
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  return token;
}

function chat(token, content, { requestId, system, mode, headers, signal } = {}) {
  const body = { messages: [{ role: "user", content }], request_id: requestId || `chatapi-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  if (system) body.system = system;
  if (mode) body.mode = mode;
  return request("POST", "/api/chat", { token, body, headers, signal });
}

function loggedModelCalls() {
  if (!fs.existsSync(callLogPath)) return [];
  return fs.readFileSync(callLogPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

// Calls that carry a phrase from one turn's message. A profile sync starts
// the auto-narrative in the background, so a bare count of new log lines
// can include a call that is not the turn's.
function callsMentioning(phrase, since = 0) {
  return loggedModelCalls().slice(since).filter((call) => JSON.stringify(call.messages || []).includes(phrase));
}

function systemOf(call) {
  const first = (call.messages || [])[0];
  if (first?.role !== "system") return "";
  return Array.isArray(first.content) ? first.content.map((part) => part.text || "").join("") : String(first.content || "");
}

// The budget rows of one chat turn: the first call is chat:<student>:<id>,
// its retries add :empty or :fidelity.
function reservationsFor(requestId) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT request_id, status FROM usage_budget_reservations WHERE request_id LIKE ? ORDER BY request_id")
      .all(`chat:%:${requestId}%`);
  } finally {
    db.close();
  }
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
      CHAT_RETRY_CUTOFF_MS: String(RETRY_CUTOFF_MS),
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

test("an empty reply is retried once on the same tier, and the retry is the answer", async () => {
  const token = await registerStudent("empty-retry");
  await grantConsents(token);
  const good = "Lead with the competition results and the mentoring you did as captain.";
  const before = loggedModelCalls().length;
  const turn = await chat(token, `How can I make my robotics club stand out? MOCKREPLY:${b64("   ")}: MOCKRETRY:${b64(good)}:`, { requestId: "empty-retry-1" });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.equal(turn.data.answer, good);
  assert.doesNotMatch(turn.data.answer, /not enough information|No verified answer/);
  const calls = loggedModelCalls().slice(before);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(systemOf(calls[0]), /EMPTY REPLY RETRY/);
  assert.match(systemOf(calls[1]), /EMPTY REPLY RETRY/);
  assert.equal(calls[1].model, calls[0].model, "the retry stays on the same tier");
  assert.deepEqual(reservationsFor("empty-retry-1").map((row) => row.status), ["reconciled", "reconciled"]);
  // Both calls were billed, so both are in the turn's usage.
  assert.equal(turn.data.usage.input_tokens, 40);
});

test("two unusable replies answer 502 empty_model_reply and leave nothing reserved", async () => {
  const token = await registerStudent("empty-twice");
  await grantConsents(token);
  const toolOnly = '<tool_call>{"name":"fetch_rag_context","arguments":{"focus":"ec"}}</tool_call>';
  const cases = [
    ["empty-twice-1", `How do I explain my robotics role? MOCKREPLY:${b64("\n \n")}:`],
    ["empty-twice-2", `How do I explain my robotics role? MOCKREPLY:${b64(toolOnly)}:`],
    // OpenRouter's 200 with an error body, on both attempts.
    ["empty-twice-3", "How do I explain my robotics role? MOCKBODYERROR:"],
  ];
  for (const [requestId, content] of cases) {
    const before = loggedModelCalls().length;
    const turn = await chat(token, content, { requestId });
    assert.equal(turn.status, 502, `${requestId} ${JSON.stringify(turn.data)}`);
    assert.equal(turn.data.code, "empty_model_reply", requestId);
    assert.doesNotMatch(JSON.stringify(turn.data), /not enough information|fetch_rag_context/);
    assert.equal(loggedModelCalls().length - before, 2, `${requestId}: one retry, no more`);
    const rows = reservationsFor(requestId);
    assert.equal(rows.length, 2, requestId);
    assert.ok(rows.every((row) => row.status === "reconciled"), `${requestId}: ${JSON.stringify(rows)}`);
  }
});

test("an upstream 401 answers 502 provider_auth_failed, never 401, and releases its reservation", async () => {
  const token = await registerStudent("upstream-401");
  await grantConsents(token);
  const rejected = await chat(token, "How should I plan junior year? MOCKSTATUS:401:", { requestId: "upstream-401-1" });
  assert.equal(rejected.status, 502, JSON.stringify(rejected.data));
  assert.equal(rejected.data.code, "provider_auth_failed");
  assert.deepEqual(reservationsFor("upstream-401-1").map((row) => row.status), ["released"]);

  const forbidden = await chat(token, "How should I plan junior year? MOCKSTATUS:403:", { requestId: "upstream-403-1" });
  assert.equal(forbidden.status, 502);
  assert.equal(forbidden.data.code, "provider_auth_failed");

  const broken = await chat(token, "How should I plan junior year? MOCKSTATUS:500:", { requestId: "upstream-500-1" });
  assert.equal(broken.status, 502, JSON.stringify(broken.data));
  assert.equal(broken.data.code, "provider_error");

  // The student's own session is still good: an ordinary turn answers.
  const ok = await chat(token, "How should I plan junior year?", { requestId: "upstream-ok-1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test("errors before the model call carry stable codes", async () => {
  const token = await registerStudent("error-codes");
  const noConsent = await chat(token, "How should I plan junior year?", { requestId: "codes-1" });
  assert.equal(noConsent.status, 403);
  assert.equal(noConsent.data.code, "consent_required");
  assert.ok(Array.isArray(noConsent.data.missing) && noConsent.data.missing.length > 0);
  assert.equal(noConsent.data.blocked, true);
  const noId = await request("POST", "/api/chat", { token, body: { messages: [{ role: "user", content: "hi there" }] } });
  assert.equal(noId.status, 400);
  assert.equal(noId.data.code, "request_id_required");
});

test("a utility call gets the model's JSON back with no profile, theme guard, advisory prefix or footer", async () => {
  const token = await registerWithProfile("utility-mode");
  const verdict = '{"passed":false,"issues":["guarantee"],"cleaned_response":"Check StudentAid.gov for the Pell Grant rules."}';

  // A counseling turn carries the profile and the rules, for contrast.
  let before = loggedModelCalls().length;
  const counseling = await chat(token, "How should I describe Robotics Club?", { requestId: "utility-contrast-1" });
  assert.equal(counseling.status, 200, JSON.stringify(counseling.data));
  const counselingSystem = systemOf(callsMentioning("How should I describe Robotics Club?", before)[0]);
  assert.match(counselingSystem, /STUDENT PROFILE/);
  assert.match(counselingSystem, /PROFILE FIDELITY/);
  assert.match(counselingSystem, /STAY ON THEME/);

  // The validator's prompt says nothing the old regex knew; the mode field
  // alone marks it.
  before = loggedModelCalls().length;
  const validator = await chat(token, `Review:\n---\nFile the FAFSA and you are guaranteed a Pell Grant; the federal loan deadline is June 30.\n---\nMOCKREPLY:${b64(verdict)}:`, {
    system: "You validate counselor drafts for a college counseling app.",
    mode: "utility",
    requestId: "utility-validator-1",
  });
  assert.equal(validator.status, 200, `${JSON.stringify(validator.data)}\n${serverOutput}`);
  assert.equal(validator.data.answer, verdict);
  assert.equal(validator.data.content[0].text, verdict);
  assert.deepEqual(JSON.parse(validator.data.answer), validator.data.json);
  assert.equal(validator.data.topic_type, "utility");
  assert.deepEqual(validator.data.limitations, []);
  assert.deepEqual(validator.data.actions, []);
  assert.deepEqual(validator.data.claims, []);
  assert.equal(validator.data._meta.jsonUtility, true);
  const validatorCalls = callsMentioning("guaranteed a Pell Grant", before);
  assert.equal(validatorCalls.length, 1);
  const utilitySystem = systemOf(validatorCalls[0]);
  assert.doesNotMatch(utilitySystem, /STUDENT PROFILE|PROFILE FIDELITY|STAY ON THEME|regulated topic|high-stakes topic|VERIFIED DATA/);

  // The gatekeeper's classification of an aid question is not filed as a
  // regulated answer.
  const gate = '{"category":"safe_college","reason":"aid eligibility","route_to":["college"]}';
  const gatekeeper = await chat(token, `Classify: "Is my family eligible for a Pell grant?" MOCKREPLY:${b64(gate)}:`, {
    system: "CLASSIFY the student's message into exactly ONE category.",
    mode: "utility",
    requestId: "utility-gatekeeper-1",
  });
  assert.equal(gatekeeper.status, 200, JSON.stringify(gatekeeper.data));
  assert.deepEqual(JSON.parse(gatekeeper.data.answer), JSON.parse(gate));
  assert.equal(gatekeeper.data.topic_type, "utility");

  // A topic mention gets no footer on a utility call: the client parses it.
  const topic = await chat(token, `Classify: "our school's suicide prevention club needs a fundraiser idea" MOCKREPLY:${b64(gate)}:`, {
    system: "CLASSIFY the student's message into exactly ONE category.",
    mode: "utility",
    requestId: "utility-topic-1",
  });
  assert.equal(topic.status, 200, JSON.stringify(topic.data));
  assert.equal(topic.data.answer, gate);
  assert.ok(!topic.data.answer.includes("741741"));

  // The mode relaxes nothing ahead of the model: a crisis message on a
  // utility call still gets the crisis reply and no model call.
  before = loggedModelCalls().length;
  const crisis = await chat(token, 'Classify: "I want to kill myself"', {
    system: "CLASSIFY the student's message into exactly ONE category.",
    mode: "utility",
    requestId: "utility-crisis-1",
  });
  assert.equal(crisis.status, 200, JSON.stringify(crisis.data));
  assert.equal(crisis.data.crisisSafe, true);
  assert.match(crisis.data.answer, /988/);
  assert.equal(callsMentioning("kill myself", before).length, 0);
});

test("a client that disconnects mid-call stops the provider call and releases its reservation", async () => {
  const token = await registerStudent("client-abort");
  await grantConsents(token);
  const controller = new AbortController();
  const pending = chat(token, "How should I plan junior year? MOCKDELAY:3000:", { requestId: "client-abort-1", signal: controller.signal })
    .then(() => "answered", (error) => error?.name || "error");
  await delay(600);
  controller.abort();
  assert.equal(await pending, "AbortError");
  // Unaborted, the mock answers at 3 s and the row is reconciled; aborted,
  // callLLM releases it as soon as the provider call throws.
  let rows = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    rows = reservationsFor("client-abort-1");
    if (rows.length && rows.every((row) => row.status !== "reserved")) break;
    await delay(100);
  }
  assert.deepEqual(rows.map((row) => row.status), ["released"], serverOutput.slice(-2000));
  await delay(3000);
  assert.deepEqual(reservationsFor("client-abort-1").map((row) => row.status), ["released"]);
});

test("past the retry cutoff the fidelity retry is skipped and the first answer carries the footnote", async () => {
  const token = await registerWithProfile("fidelity-cutoff");
  const wrong = "Your A in AP English Language and Composition shows strong writing. Keep building on Robotics Club.";
  const fixed = "Your B+ in AP English Language and Composition shows strong writing. Keep building on Robotics Club.";
  const before = loggedModelCalls().length;
  const turn = await chat(token, `How should I frame my English strengths? MOCKDELAY:${RETRY_CUTOFF_MS + 500}: MOCKREPLY:${b64(wrong)}: MOCKRETRY:${b64(fixed)}:`, { requestId: "fidelity-cutoff-1" });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.equal(turn.data._meta.profileFidelity?.resolved, "footnote_no_time");
  assert.ok(turn.data.answer.startsWith(wrong), turn.data.answer);
  assert.ok(turn.data.answer.length > wrong.length, "the correction footnote is attached");
  const calls = callsMentioning("frame my English strengths", before);
  assert.equal(calls.length, 1, "no retry was started");
  assert.doesNotMatch(JSON.stringify(calls), /FIDELITY CORRECTION/);
});

// Decision E's backstop: a fidelity retry that fixes the student's grade but
// drops a school figure the first answer took from the VERIFIED DATA block
// loses to the first answer with the correction footnote.
test("a fidelity retry that drops a verified school figure keeps the first answer and the footnote", async () => {
  const token = await registerWithProfile("fidelity-verified");
  const question = "How do my English strengths fit Stanford University?";
  let before = loggedModelCalls().length;
  const probe = await chat(token, `${question} MOCKREPLY:${b64("Keep building on Robotics Club.")}:`, { requestId: "fidelity-verified-probe" });
  assert.equal(probe.status, 200, JSON.stringify(probe.data));
  const probeSystem = systemOf(callsMentioning(question, before)[0]);
  // The block itself, not the rule text that names it.
  const blockStart = probeSystem.indexOf("VERIFIED DATA (");
  assert.ok(blockStart >= 0, "the question names a school the store holds");
  const block = probeSystem.slice(blockStart);
  const figure = (block.match(/\d{1,3}(?:,\d{3})+|\d+\.\d+%?|\d{2,}%/) || [])[0];
  assert.ok(figure, block.slice(0, 400));

  const wrong = `Your A in AP English Language and Composition stands out, and Stanford's figure of ${figure} is worth knowing. Keep building on Robotics Club.`;
  const fixedButDropped = "Your B+ in AP English Language and Composition stands out. Keep building on Robotics Club.";
  before = loggedModelCalls().length;
  const turn = await chat(token, `${question} MOCKREPLY:${b64(wrong)}: MOCKRETRY:${b64(fixedButDropped)}:`, { requestId: "fidelity-verified-1" });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput.slice(-2000)}`);
  assert.equal(turn.data._meta.profileFidelity?.resolved, "footnote_kept_verified");
  assert.ok(turn.data.answer.startsWith(wrong), turn.data.answer);
  assert.ok(turn.data.answer.length > wrong.length, "the correction footnote is attached");
  assert.equal(callsMentioning(question, before).length, 2, "the retry ran");
});
