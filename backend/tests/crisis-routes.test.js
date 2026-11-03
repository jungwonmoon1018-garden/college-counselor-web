// The deterministic crisis reply, end to end through the real server. Until
// 2026-11 the chat route sent the hotlines only in `actions`, with no
// topic_type, and read the locale from Accept-Language alone (which the
// client always sent as en-US): a student the server caught saw "Please reach
// out to one of these resources:" and nothing after it, and a Korean student
// never saw a Korean line. Spawns server.js with the OpenRouter mock, as the
// other route tests do, and counts model calls through its call log.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FETCH_MOCK = path.join(__dirname, "helpers", "mock-openrouter-fetch.mjs");

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

// Up to a minute: a boot loads the whole module graph and ingests the CDS
// cache, and a busy runner turned shorter waits into false failures.
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
  assert.ok(result.data.token);
  return result.data.token;
}

async function grantConsents(token) {
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", { token, body: { consentType, grantedBy: "student" } });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }
}

function modelCallCount() {
  if (!fs.existsSync(callLogPath)) return 0;
  return fs.readFileSync(callLogPath, "utf8").split(/\r?\n/).filter(Boolean).length;
}

function chat(token, content, { system, headers, requestId, query = "" } = {}) {
  return request("POST", `/api/chat${query}`, {
    token,
    headers,
    body: {
      messages: [{ role: "user", content }],
      ...(system ? { system } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    },
  });
}

const US_LINES = ["911", "988", "741741", "1-800-422-4453"];
const KO_LINES = ["109", "1388", "119", "112"];

function assertCrisisReply(data, lines) {
  assert.equal(data.crisisSafe, true, JSON.stringify(data));
  assert.equal(data.topic_type, "crisis");
  assert.equal(data._meta.topicType, "CRISIS");
  assert.equal(data._meta.modelTier, "NONE");
  for (const line of lines) assert.ok(data.answer.includes(line), `answer lists ${line}:\n${data.answer}`);
  assert.equal(data.content[0].text, data.answer);
  assert.ok(!/1393|1577-0199/.test(data.answer), "the retired Korean numbers are gone");
  assert.ok(!/\[object Object\]/.test(data.answer));
  assert.equal(Number(data.usage?.input_tokens || 0) + Number(data.usage?.output_tokens || 0), 0);
}

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

// The crisis branch runs before the request_id and consent checks, so a
// student who has not granted consent yet still gets the hotlines.
test("an English safety statement gets every US line in the answer text, with no model call", async () => {
  const token = await registerStudent("crisis-en");
  const calls = modelCallCount();
  for (const content of ["I don't feel safe at home", "I’m not safe at home", "everyone would be better off without me"]) {
    const turn = await chat(token, content);
    assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
    assertCrisisReply(turn.data, US_LINES);
    assert.ok(!turn.data.answer.includes("1388"), "an English reply has no Korean lines");
  }
  assert.equal(modelCallCount(), calls, "a crisis reply never calls the model");
});

test("a Korean student gets the Korean lines first, then the US lines, from any locale signal", async () => {
  const token = await registerStudent("crisis-ko");
  const calls = modelCallCount();
  const message = "요즘 너무 힘들어서 죽고 싶어요";
  for (const options of [
    { headers: { "X-CollegeApp-Locale": "ko" } },
    { query: "?locale=ko", headers: { "Accept-Language": "en-US" } },
    { headers: { "Accept-Language": "ko-KR,ko;q=0.9" } },
  ]) {
    const turn = await chat(token, message, options);
    assert.equal(turn.status, 200, JSON.stringify(turn.data));
    assertCrisisReply(turn.data, [...KO_LINES, ...US_LINES]);
    assert.ok(turn.data.answer.indexOf("109") < turn.data.answer.indexOf("988"), "Korean lines come first");
    assert.match(turn.data.answer, /자살예방상담전화/);
  }
  const english = await chat(token, message, { headers: { "Accept-Language": "en-US" } });
  assertCrisisReply(english.data, US_LINES);
  assert.ok(!english.data.answer.includes("1388"));
  assert.equal(modelCallCount(), calls);
});

// The client's gatekeeper sends the student's words inside a JSON-only
// classification prompt. Its reply must be the crisis reply, which the
// client recognizes before it parses anything.
test("a utility-shaped call carrying a crisis message still gets the crisis reply", async () => {
  const token = await registerStudent("crisis-utility");
  const calls = modelCallCount();
  const gatekeeper = await chat(token, 'Classify: "죽고 싶어요"', {
    system: "CLASSIFY the student's message into exactly ONE category. Respond ONLY with valid JSON.",
    headers: { "X-CollegeApp-Locale": "ko" },
  });
  assert.equal(gatekeeper.status, 200, JSON.stringify(gatekeeper.data));
  assertCrisisReply(gatekeeper.data, KO_LINES);
  const validator = await chat(token, "Review:\n---\nI want to kill myself\n---", {
    system: "You validate responses for a college counseling app (students ages 14-18). Respond JSON only.",
  });
  assertCrisisReply(validator.data, US_LINES);
  assert.equal(modelCallCount(), calls);
});

test("the Council route sends the same reply, before the explicit-action, consent and budget checks", async () => {
  const token = await registerStudent("crisis-council");
  const calls = modelCallCount();
  const english = await request("POST", "/api/council/convene", {
    token,
    body: { question: "Should I apply ED to Harvard? Honestly everyone would be better off without me if I fail." },
  });
  assert.equal(english.status, 200, JSON.stringify(english.data));
  assertCrisisReply(english.data, US_LINES);
  const korean = await request("POST", "/api/council/convene", {
    token,
    headers: { "X-CollegeApp-Locale": "ko" },
    body: { question: "아빠가 저를 때려요. 어떤 대학에 지원해야 할까요?", explicit: true, auto: false },
  });
  assertCrisisReply(korean.data, [...KO_LINES, ...US_LINES]);
  assert.equal(modelCallCount(), calls, "the Council never convenes on a crisis question");
});

// Owner decision: a topic mention is answered, and the safety net stays.
test("a question naming suicide as a topic gets a normal answer with the 988 / 741741 footer", async () => {
  const token = await registerStudent("crisis-topic");
  await grantConsents(token);
  const calls = modelCallCount();
  const turn = await chat(token, "our school's suicide prevention club needs a fundraiser idea", { requestId: "crisis-topic-1" });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.notEqual(turn.data.crisisSafe, true);
  assert.notEqual(turn.data.topic_type, "crisis");
  assert.match(turn.data.answer, /Junior Year Course Plan/, "the model's answer is there");
  assert.match(turn.data.answer, /call or text 988, or text HOME to 741741/);
  assert.equal(turn.data.content[0].text, turn.data.answer);
  assert.equal(modelCallCount(), calls + 1);

  const korean = await chat(token, "자살 예방 동아리 기금 모금 아이디어가 필요해요", { requestId: "crisis-topic-2", headers: { "X-CollegeApp-Locale": "ko" } });
  assert.equal(korean.status, 200, JSON.stringify(korean.data));
  assert.notEqual(korean.data.crisisSafe, true);
  assert.match(korean.data.answer, /109\(24시간 상담\)/);

  // A JSON utility call gets no footer: the client parses its reply.
  const utility = await chat(token, 'Classify: "our school\'s suicide prevention club needs a fundraiser idea"', {
    system: "CLASSIFY the student's message into exactly ONE category. Respond ONLY with valid JSON.",
    requestId: "crisis-topic-3",
  });
  assert.equal(utility.status, 200, JSON.stringify(utility.data));
  assert.ok(!String(utility.data.answer).includes("741741"));
});

test("an idiom that only looks like danger is answered without the crisis reply or the footer", async () => {
  const token = await registerStudent("crisis-idiom");
  await grantConsents(token);
  for (const [index, content] of [
    "I'm in danger of failing AP Chem, what should I do?",
    "I hurt myself playing soccer and missed junior season, how do I explain it?",
    "It's an emergency, my Common App won't submit and the deadline is tonight!",
  ].entries()) {
    const turn = await chat(token, content, { requestId: `crisis-idiom-${index}` });
    assert.equal(turn.status, 200, `${content}\n${JSON.stringify(turn.data)}`);
    assert.notEqual(turn.data.crisisSafe, true, content);
    assert.notEqual(turn.data.topic_type, "crisis", content);
    assert.ok(!String(turn.data.answer).includes("741741"), content);
  }
});
