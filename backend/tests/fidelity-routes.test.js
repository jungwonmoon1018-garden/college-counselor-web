// The chat's profile-fidelity check through POST /api/chat (2026-11-03): a
// true comparison with a school's verified figure, a hedged piece of advice,
// a retaker's newer score and a target or a school's figure listed after the
// student's own make no corrective retry, while a real
// misstatement, including a score invented for an AP exam with none on
// record, still gets one; the footnote is Korean under the Korean locale;
// and a school named in lower case or in Hangul reaches the VERIFIED DATA
// block.
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
// cache, and a busy runner can take seconds per process launch.
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

function loggedModelCalls() {
  if (!fs.existsSync(callLogPath)) return [];
  return fs.readFileSync(callLogPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Scripted replies ride in the student message as base64 markers the fetch
// mock understands (see helpers/mock-openrouter-fetch.mjs).
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function callsFor(marker) {
  return loggedModelCalls().filter((call) => JSON.stringify(call.messages).includes(marker.slice(0, 40)));
}

const BASE_PROFILE = {
  gpa: { unweighted: 3.82, weighted: 4.31 },
  courses: [
    { name: "English Language and Composition", type: "ap", grade: "B+", year: "junior" },
    { name: "Statistics", type: "ap", grade: "A", year: "junior" },
    { name: "Calculus BC", type: "ap", grade: "IP", year: "senior" },
  ],
  testScores: [{ test: "sat", totalScore: 1450 }],
  apScores: [{ exam: "Statistics", score: 4, year: 2026 }],
};

async function registerWithProfile(label, profile = BASE_PROFILE) {
  const registered = await request("POST", "/api/students/register", {
    body: {
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: "correct horse battery staple",
      grade: 11,
      state: "CA",
      schoolDomain: "example.edu",
      majorInterest: "Computer Science",
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const token = registered.data.token;
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", { token, body: { consentType, grantedBy: "student" } });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }
  const synced = await request("POST", "/api/students/sync", {
    token,
    body: {
      profile,
      activities: [{ name: "Robotics Club", role: "Captain", category: "robotics", hoursPerWeek: 8 }],
      majorInterest: "Computer Science",
      goals: [],
    },
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  return token;
}

async function chat(token, question, marker, requestId, headers = {}) {
  const turn = await request("POST", "/api/chat", {
    token,
    headers,
    body: { messages: [{ role: "user", content: `${question} ${marker}` }], request_id: requestId },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  return turn;
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
    if (serverProcess.exitCode == null) serverProcess.kill("SIGKILL"); // a server that will not exit must not hang the runner
  }
  const resolved = testDataDir ? path.resolve(testDataDir) : "";
  const expectedRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(expectedRoot) && path.basename(resolved).startsWith("college-counselor-route-tests-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

// The comparison the VERIFIED DATA block exists for used to be read as a
// misstated SAT of 1510: a second paid call, and a correction telling the
// model to rewrite Stanford's figure.
test("a true comparison with a school's figure makes no corrective retry", async () => {
  const token = await registerWithProfile("fidelity-compare");
  const reply = "Your SAT of 1450 is 60 points below Stanford's 1510, and your 3.82 GPA is close to Stanford's 3.94.";
  const marker = `MOCKREPLY:${b64(reply)}:`;
  const turn = await chat(token, "How do I compare to Stanford University?", marker, "fidelity-compare-1");
  assert.equal(turn.data._meta.profileFidelity, null);
  assert.equal(turn.data.answer, reply);
  const calls = callsFor(marker);
  assert.equal(calls.length, 1, "no corrective retry");
  assert.doesNotMatch(JSON.stringify(calls), /FIDELITY CORRECTION/);
});

test("hedged advice about a grade or AP score still to come makes no corrective retry", async () => {
  const token = await registerWithProfile("fidelity-hedged");
  const reply = "An A in AP Calculus BC this year would help, and a 5 on the AP Calculus BC exam would earn credit at many schools. Aim for a 5 on AP Statistics if you retake it.";
  const marker = `MOCKREPLY:${b64(reply)}:`;
  const turn = await chat(token, "What should I focus on this year?", marker, "fidelity-hedged-1");
  assert.equal(turn.data._meta.profileFidelity, null);
  assert.equal(callsFor(marker).length, 1);
});

// A retaker's newer score was "corrected" back to the first sitting.
test("a retaker's newer SAT sitting is a true score", async () => {
  const token = await registerWithProfile("fidelity-sittings", {
    ...BASE_PROFILE,
    testScores: [{ test: "sat", totalScore: 1390, date: "2026-03" }, { test: "sat", totalScore: 1450, date: "2026-10" }],
  });
  const reply = "Your SAT of 1450 from October is your best score, up from your 1390 SAT in March.";
  const marker = `MOCKREPLY:${b64(reply)}:`;
  const turn = await chat(token, "Is my SAT good enough for Michigan?", marker, "fidelity-sittings-1");
  assert.equal(turn.data._meta.profileFidelity, null);
  assert.equal(callsFor(marker).length, 1);
});

test("a misstated score in a comparison is corrected, and the correction names only the student's value", async () => {
  const token = await registerWithProfile("fidelity-misstated");
  const wrong = "Your SAT of 1500 is 50 points below Stanford's 1550.";
  const fixed = "Your SAT of 1450 is 100 points below Stanford's 1550.";
  const marker = `MOCKREPLY:${b64(wrong)}: MOCKRETRY:${b64(fixed)}:`;
  const turn = await chat(token, "How do I compare to Stanford University?", marker, "fidelity-misstated-1");
  assert.equal(turn.data._meta.profileFidelity?.resolved, "retry");
  assert.deepEqual(turn.data._meta.profileFidelity.contradictions.map((c) => [c.kind, c.stated]), [["sat", "1500"]]);
  assert.equal(turn.data.answer, fixed);
  const calls = callsFor(marker);
  assert.equal(calls.length, 2, "one draft call plus one corrective retry");
  const retryWire = JSON.stringify(calls[1].messages);
  assert.match(retryWire, /- SAT: recorded 1450 \(the reply said 1500\)/);
  assert.doesNotMatch(retryWire, /the reply said 1550/);
});

// The second item of a list had no binder of its own, so "your 3.82 GPA and
// 1520 SAT" went to the student with the invented 1520 and no footnote.
test("an invented score later in a list of the student's numbers is corrected", async () => {
  const token = await registerWithProfile("fidelity-list");
  const wrong = "With your 3.82 GPA and 1520 SAT, you're a strong candidate for Michigan.";
  const fixed = "With your 3.82 GPA and 1450 SAT, you're a strong candidate for Michigan.";
  const marker = `MOCKREPLY:${b64(wrong)}: MOCKRETRY:${b64(fixed)}:`;
  const turn = await chat(token, "Am I competitive for Michigan?", marker, "fidelity-list-1");
  assert.equal(turn.data._meta.profileFidelity?.resolved, "retry");
  assert.deepEqual(turn.data._meta.profileFidelity.contradictions.map((c) => [c.kind, c.stated]), [["sat", "1520"]]);
  assert.equal(turn.data.answer, fixed);
  const calls = callsFor(marker);
  assert.equal(calls.length, 2, "one draft call plus one corrective retry");
  assert.match(JSON.stringify(calls[1].messages), /- SAT: recorded 1450 \(the reply said 1520\)/);
});

// Reading a list on from the student's score took a goal or a school's
// figure after it for the student's own, and the retry told the model
// "recorded 1450 (the reply said 1520)", pushing it to overwrite the target.
test("a target or a school's figure listed after the student's score makes no corrective retry", async () => {
  const token = await registerWithProfile("fidelity-list-target");
  const reply = "Your 1450 SAT and 1520 SAT goal are 70 points apart. Your 3.82 GPA and 1450 SAT — 1530 SAT would be ideal for Michigan, and your 1450 SAT and 1500 SAT is Michigan's median.";
  const marker = `MOCKREPLY:${b64(reply)}:`;
  const turn = await chat(token, "Am I competitive for Michigan?", marker, "fidelity-list-target-1");
  assert.equal(turn.data._meta.profileFidelity, null);
  assert.equal(turn.data.answer, reply);
  const calls = callsFor(marker);
  assert.equal(calls.length, 1, "no corrective retry");
  assert.doesNotMatch(JSON.stringify(calls), /FIDELITY CORRECTION/);
});

// The target rule first read "admit" and "target" as nouns even with an
// object after them, and any capitalized possessive as a school's, so an
// invented 1520 before "admit you" or "is Jiyeon's best" went out unchecked.
test("an invented score listed before a verb or a person's possessive is still corrected", async () => {
  const token = await registerWithProfile("fidelity-list-verb");
  const wrong = "Your 3.82 GPA and 1520 SAT admit you to most schools on your list, and your 3.82 GPA and 1520 SAT is Jiyeon's best.";
  const fixed = "Your 3.82 GPA and 1450 SAT admit you to most schools on your list.";
  const marker = `MOCKREPLY:${b64(wrong)}: MOCKRETRY:${b64(fixed)}:`;
  const turn = await chat(token, "Am I competitive for Michigan?", marker, "fidelity-list-verb-1");
  assert.equal(turn.data._meta.profileFidelity?.resolved, "retry");
  assert.deepEqual(turn.data._meta.profileFidelity.contradictions.map((c) => [c.kind, c.stated]), [["sat", "1520"]]);
  assert.equal(turn.data.answer, fixed);
  const calls = callsFor(marker);
  assert.equal(calls.length, 2, "one draft call plus one corrective retry");
  assert.match(JSON.stringify(calls[1].messages), /- SAT: recorded 1450 \(the reply said 1520\)/);
});

// An AP exam with no score on record was never checked, and the profile
// block said nothing when there were no AP scores at all.
test("a score invented for an AP course still in progress is corrected, and the profile says no AP scores are recorded", async () => {
  const token = await registerWithProfile("fidelity-ap-none", { ...BASE_PROFILE, apScores: [] });
  const wrong = "You got a 5 on AP Calculus BC, which MIT will notice.";
  const fixed = "AP Calculus BC is in progress, and its exam is in May, so there is no score yet.";
  const marker = `MOCKREPLY:${b64(wrong)}: MOCKRETRY:${b64(fixed)}:`;
  const turn = await chat(token, "What stands out in my record for MIT?", marker, "fidelity-ap-none-1");
  assert.equal(turn.data._meta.profileFidelity?.resolved, "retry");
  assert.deepEqual(turn.data._meta.profileFidelity.contradictions.map((c) => c.kind), ["ap_not_on_record"]);
  const calls = callsFor(marker);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[0].messages), /AP exam scores: none recorded/);
  assert.match(JSON.stringify(calls[1].messages), /AP Calculus BC exam: the course is in progress and no exam score is recorded yet \(the reply said 5\)/);
});

test("the correction footnote is Korean under the Korean locale", async () => {
  const token = await registerWithProfile("fidelity-korean");
  const wrong = "학생의 SAT 점수 1500점은 아주 경쟁력 있습니다.";
  const marker = `MOCKREPLY:${b64(wrong)}: MOCKRETRY:${b64(wrong)}:`;
  const turn = await chat(token, "제 성적으로 미시간 가능할까요?", marker, "fidelity-korean-1", { "Accept-Language": "ko", "X-CollegeApp-Locale": "ko" });
  assert.equal(turn.data._meta.profileFidelity?.resolved, "footnote");
  assert.match(turn.data.answer, /_저장된 프로필 기준 정정 — 위 답변의 다음 값은 기록과 다릅니다:_/);
  assert.match(turn.data.answer, /- SAT: 기록된 점수 1450 \(답변에서는 1500\)/);
  assert.doesNotMatch(turn.data.answer, /the reply said/);
});

// "ucla" and "스탠퍼드" matched no school, so the turn had no VERIFIED DATA
// block and the model answered from memory.
test("a school named in lower case or in Hangul reaches the VERIFIED DATA block", async () => {
  const token = await registerWithProfile("fidelity-school-names");
  const lower = await chat(token, "how do i fit at ucla as a cs applicant?", `MOCKREPLY:${b64("Here is how you fit.")}:`, "fidelity-school-names-1");
  assert.equal(lower.data._meta.verifiedData, true);
  let calls = loggedModelCalls();
  assert.match(JSON.stringify(calls[calls.length - 1].messages), /- University of California-Los Angeles[^"]*\[Source: /);

  const hangul = await chat(token, "스탠퍼드에서 제 위치는 어떤가요?", `MOCKREPLY:${b64("위치를 설명해 드릴게요.")}:`, "fidelity-school-names-2", { "Accept-Language": "ko" });
  assert.equal(hangul.data._meta.verifiedData, true);
  calls = loggedModelCalls();
  assert.match(JSON.stringify(calls[calls.length - 1].messages), /- Stanford University \(CA\): /);
});
