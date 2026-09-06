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
  for (let attempt = 0; attempt < 80; attempt++) {
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
  return {
    status: response.status,
    data: text ? JSON.parse(text) : null,
  };
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

async function createThread(token, title = "New conversation") {
  const result = await request("POST", "/api/students/threads", { token, body: { title } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.ok(result.data.id);
  return result.data.id;
}

async function appendUserMessage(token, threadId, content) {
  return request("POST", `/api/students/threads/${threadId}/messages`, {
    token,
    body: { role: "user", content },
  });
}

async function createDeadline(token, title, collegeIds = null) {
  const result = await request("POST", "/api/students/deadlines", {
    token,
    body: {
      title,
      dueAt: "2027-12-01T12:00:00.000Z",
      category: "admissions",
      collegeIds,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.deadline;
}

async function listDeadlineTitles(token) {
  const result = await request("GET", "/api/students/deadlines", { token });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.deadlines.map((deadline) => deadline.title);
}

function loggedModelCalls() {
  if (!fs.existsSync(callLogPath)) return [];
  return fs.readFileSync(callLogPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
  }

  const resolved = testDataDir ? path.resolve(testDataDir) : "";
  const expectedRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(expectedRoot) && path.basename(resolved).startsWith("college-counselor-route-tests-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("chat auto-name persists a generated title and keeps crisis text off the model route", async () => {
  const token = await registerStudent("autoname");

  const crisisThread = await createThread(token);
  const crisisAppend = await appendUserMessage(token, crisisThread, "I want to kill myself");
  assert.equal(crisisAppend.status, 200, JSON.stringify(crisisAppend.data));

  const crisisName = await request("POST", `/api/students/threads/${crisisThread}/autoname`, { token, body: {} });
  assert.equal(crisisName.status, 200, JSON.stringify(crisisName.data));
  assert.equal(crisisName.data.title, "Support resources");
  assert.equal(crisisName.data.crisisSafe, true);

  const persistedCrisis = await request("GET", `/api/students/threads/${crisisThread}`, { token });
  assert.equal(persistedCrisis.status, 200);
  assert.equal(persistedCrisis.data.thread.title, "Support resources");
  assert.equal(loggedModelCalls().length, 0, "crisis auto-name must not call OpenRouter");

  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", {
      token,
      body: { consentType, grantedBy: "student", locale: "en" },
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }

  const ordinaryThread = await createThread(token);
  const ordinaryAppend = await appendUserMessage(token, ordinaryThread, "Help me choose AP classes for next year");
  assert.equal(ordinaryAppend.status, 200, JSON.stringify(ordinaryAppend.data));
  const ordinaryName = await request("POST", `/api/students/threads/${ordinaryThread}/autoname`, { token, body: {} });
  assert.equal(ordinaryName.status, 200, `${JSON.stringify(ordinaryName.data)}\n${serverOutput}`);
  assert.equal(ordinaryName.data.title, "Junior Year Course Plan");

  const persistedOrdinary = await request("GET", `/api/students/threads/${ordinaryThread}`, { token });
  assert.equal(persistedOrdinary.status, 200);
  assert.equal(persistedOrdinary.data.thread.title, "Junior Year Course Plan");
  const calls = loggedModelCalls();
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0].messages), /choose AP classes/i);
  assert.doesNotMatch(JSON.stringify(calls), /kill myself/i);
});

test("deadline cascade is tenant-scoped and matches literal school names and complete unit IDs", async () => {
  const firstToken = await registerStudent("deadlines-first");
  const secondToken = await registerStudent("deadlines-second");

  await createDeadline(firstToken, "A_%B ??Regular Decision");
  await createDeadline(firstToken, "AxxB ??Keep this unrelated deadline");
  await createDeadline(secondToken, "A_%B ??Other student's deadline");

  const noAuth = await request("DELETE", "/api/students/deadlines/by-school", {
    body: { schoolName: "A_%B" },
  });
  assert.equal(noAuth.status, 401);

  const literalDelete = await request("DELETE", "/api/students/deadlines/by-school", {
    token: firstToken,
    body: { schoolName: "A_%B" },
  });
  assert.equal(literalDelete.status, 200, JSON.stringify(literalDelete.data));
  assert.equal(literalDelete.data.deleted, 1);
  assert.deepEqual(await listDeadlineTitles(firstToken), ["AxxB ??Keep this unrelated deadline"]);
  assert.deepEqual(await listDeadlineTitles(secondToken), ["A_%B ??Other student's deadline"]);

  await createDeadline(firstToken, "Exact unit ID", ["166683"]);
  await createDeadline(firstToken, "Containing-but-different unit ID", ["91666839"]);
  await createDeadline(secondToken, "Same unit ID, different student", ["166683"]);

  const partialDelete = await request("DELETE", "/api/students/deadlines/by-school", {
    token: firstToken,
    body: { unitId: "166" },
  });
  assert.equal(partialDelete.status, 200, JSON.stringify(partialDelete.data));
  assert.equal(partialDelete.data.deleted, 0);
  assert.ok((await listDeadlineTitles(firstToken)).includes("Exact unit ID"));

  const exactDelete = await request("DELETE", "/api/students/deadlines/by-school", {
    token: firstToken,
    body: { unitId: "166683" },
  });
  assert.equal(exactDelete.status, 200, JSON.stringify(exactDelete.data));
  assert.equal(exactDelete.data.deleted, 1);

  const firstTitles = await listDeadlineTitles(firstToken);
  assert.ok(!firstTitles.includes("Exact unit ID"));
  assert.ok(firstTitles.includes("Containing-but-different unit ID"));
  assert.ok((await listDeadlineTitles(secondToken)).includes("Same unit ID, different student"));
});

test("consent status reports missing onboarding rows and clears once granted", async () => {
  const token = await registerStudent("consent-status");

  // Registration alone grants nothing (the frontend records consents), so a
  // fresh account must surface the missing rows here instead of features
  // silently 403ing later. cross_border_transfer is the row older signup
  // builds never granted.
  const before = await request("GET", "/api/consent/status", { token });
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.ok(before.data.missing.includes("cross_border_transfer"));
  assert.equal(before.data.consents.cross_border_transfer, false);

  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const granted = await request("POST", "/api/consent/grant", {
      token,
      body: { consentType, grantedBy: "student" },
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
  }

  const after = await request("GET", "/api/consent/status", { token });
  assert.equal(after.status, 200, JSON.stringify(after.data));
  assert.deepEqual(after.data.missing, []);
  assert.equal(after.data.consents.cross_border_transfer, true);
});

test("transcript import succeeds on repeated uploads for the same student", async () => {
  const token = await registerStudent("transcript-import");
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", {
      token,
      body: { consentType, grantedBy: "student" },
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }

  const transcriptText = [
    "Official High School Transcript",
    "Grade 11 (Junior Year)",
    "AP Calculus BC  A  Full Year",
    "Cumulative unweighted GPA: 3.8",
  ].join("\n");
  const upload = () => request("POST", "/api/students/transcript-import", {
    token,
    body: {
      base64: Buffer.from(transcriptText, "utf8").toString("base64"),
      mimeType: "text/plain",
      filename: "transcript.txt",
    },
  });

  // Regression: the route once reused one constant budget request_id per
  // student, so the ledger's idempotency check made the FIRST import work
  // and every later one fail. Both of these must succeed.
  const first = await upload();
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.gpa, 3.8);
  assert.equal(first.data.courses.junior[0].name, "AP Calculus BC");

  const second = await upload();
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.courseCount, 1);
});

test("chat route serves a coaching turn with a request_id and rejects one without", async () => {
  const token = await registerStudent("chat-route");
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", {
      token,
      body: { consentType, grantedBy: "student" },
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }

  const messages = [{ role: "user", content: "What extracurriculars should I add for a computer science major?" }];

  // The frontend must send a request_id with every paid model call ??the
  // budget ledger reserves under it. A turn without one is rejected, which
  // (before the frontend fix) surfaced as a generic error on every
  // model-backed chat turn, most visibly file-attachment turns.
  const missingId = await request("POST", "/api/chat", { token, body: { messages } });
  assert.equal(missingId.status, 400, JSON.stringify(missingId.data));
  assert.match(String(missingId.data.error), /request_id/);

  const ok = await request("POST", "/api/chat", { token, body: { messages, request_id: "chat-route-test-1" } });
  assert.equal(ok.status, 200, `${JSON.stringify(ok.data)}\n${serverOutput}`);
  assert.ok(String(ok.data.answer || "").length > 0);
});

test("chat does not serve the FAFSA checklist for non-aid eligibility questions", async () => {
  const token = await registerStudent("eligibility-chat");
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", {
      token,
      body: { consentType, grantedBy: "student" },
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }

  // Regression: any chat message containing "eligible" used to get the full
  // federal FAFSA eligibility checklist. Admissions-eligibility questions
  // must reach the model instead.
  const admissions = await request("POST", "/api/chat", {
    token,
    body: {
      messages: [{ role: "user", content: "Am I eligible for Princeton with a 3.8 GPA?" }],
      request_id: "eligibility-chat-1",
    },
  });
  assert.equal(admissions.status, 200, `${JSON.stringify(admissions.data)}\n${serverOutput}`);
  assert.doesNotMatch(String(admissions.data.answer), /eligibility item/i);
  assert.equal(admissions.data._meta.deterministic, false);

  // Genuine federal-aid eligibility checks still get the deterministic
  // rules-engine answer without a model call.
  const federal = await request("POST", "/api/chat", {
    token,
    body: {
      messages: [{ role: "user", content: "Am I eligible for FAFSA federal student aid?" }],
    },
  });
  assert.equal(federal.status, 200, JSON.stringify(federal.data));
  assert.equal(federal.data._meta.deterministic, true);
});

test("chat injects the student profile and theme guard into model calls", async () => {
  const token = await registerStudent("profile-context");
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", {
      token,
      body: { consentType, grantedBy: "student" },
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }
  const synced = await request("POST", "/api/students/sync", {
    token,
    body: {
      profile: {
        gpa: { unweighted: 3.9 },
        courses: [
          { name: "AP Calculus BC", type: "ap", grade: "A", year: "junior" },
          { name: "English Language and Composition", type: "ap", grade: "B+", year: "junior" },
          { name: "Physics C: Mechanics", type: "ap", grade: "IP", year: "senior" },
        ],
        testScores: [{ test: "sat", totalScore: 1450 }],
        // The survey writes AP scores as {exam, score, year}; the chat route
        // used to read `.subject` and showed the model "undefined: 5".
        apScores: [{ exam: "Calculus BC", score: 5, year: 2025 }],
      },
      activities: [{ name: "Robotics Club", role: "Captain", category: "robotics", hoursPerWeek: 8, weeksPerYear: 30, grades: ["junior"], description: "Built the drivetrain controller." }],
      majorInterest: "Computer Science",
      goals: [],
    },
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));

  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      messages: [{ role: "user", content: "What extracurriculars should I add next?" }],
      request_id: "profile-context-1",
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  // Every model-backed turn reports where its time went, stage by stage.
  const timings = turn.data._meta?.timings;
  assert.ok(timings, "expected _meta.timings");
  for (const stage of ["classify", "context", "model", "total"]) {
    assert.ok(Number.isInteger(timings[stage]) && timings[stage] >= 0, `timings.${stage} = ${timings[stage]}`);
  }
  assert.match(serverOutput, /\[CHAT\] timings \{/);

  // The web deployment has no client-side tool loop, so the profile must be
  // injected server-side or the model coaches blind and drifts off-theme.
  const calls = loggedModelCalls();
  const last = calls[calls.length - 1];
  const wire = JSON.stringify(last.messages);
  assert.match(wire, /STAY ON THEME/);
  // The guard must keep student-provided material in scope: an NHD history
  // project for a STEM applicant was once refused as "unrelated to your
  // college application goals". The instruction has to say uploads count
  // regardless of subject/major, and must not order a blanket decline.
  assert.match(wire, /regardless of (?:its subject|whether it matches)/i);
  assert.match(wire, /Never refuse to engage with student-provided material/);
  assert.match(wire, /STUDENT PROFILE/);
  assert.match(wire, /PROFILE FIDELITY/);
  // One course per line with year, level, and an explicit grade legend — the
  // old one-line dump was where grades got transposed between neighbours.
  assert.match(wire, /junior: AP Calculus BC — AP — grade A/);
  assert.match(wire, /junior: AP English Language and Composition — AP — grade B\+/);
  assert.match(wire, /senior: AP Physics C: Mechanics — AP — in progress/);
  assert.match(wire, /AP exam scores: AP Calculus BC: 5 \(2025\)/);
  assert.match(wire, /Test scores: SAT 1450/);
  assert.match(wire, /Robotics Club — Captain \(robotics\); 8 hrs\/wk × 30 wks\/yr; years: junior; \\"Built the drivetrain controller\.\\"/);
  assert.doesNotMatch(wire, /undefined/);
  // An EC question that names no school gets no college-data block.
  assert.equal(turn.data._meta.verifiedData, false);
});

// Scripted replies for the fidelity tests ride in the student message as
// base64 markers the fetch mock understands (see helpers/mock-openrouter-fetch).
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

async function registerWithProfile(label) {
  const token = await registerStudent(label);
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", { token, body: { consentType, grantedBy: "student" } });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }
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
        apScores: [{ exam: "Statistics", score: 4, year: 2026 }],
      },
      activities: [{ name: "Robotics Club", role: "Captain", category: "robotics", hoursPerWeek: 8 }],
      majorInterest: "Computer Science",
      goals: [],
    },
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  return token;
}

test("chat retries a reply that misstates a recorded grade and returns the corrected answer", async () => {
  const token = await registerWithProfile("fidelity-retry");
  const wrong = "Your A in AP English Language and Composition and your 1450 SAT show strong writing. Keep building on Robotics Club.";
  const fixed = "Your B+ in AP English Language and Composition and your 1450 SAT show strong writing. Keep building on Robotics Club.";
  const marker = `MOCKREPLY:${b64(wrong)}: MOCKRETRY:${b64(fixed)}:`;
  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      messages: [{ role: "user", content: `How should I frame my English strengths? ${marker}` }],
      request_id: "fidelity-retry-1",
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.equal(turn.data.answer, fixed);
  assert.equal(turn.data._meta.profileFidelity?.resolved, "retry");
  assert.equal(turn.data._meta.profileFidelity.contradictions[0].kind, "course_grade");

  const calls = loggedModelCalls().filter((call) => JSON.stringify(call.messages).includes(marker.slice(0, 40)));
  assert.equal(calls.length, 2, "one draft call plus one corrective retry");
  const retryWire = JSON.stringify(calls[1].messages);
  assert.match(retryWire, /FIDELITY CORRECTION/);
  assert.match(retryWire, /AP English Language and Composition: recorded grade B\+ \(the reply said A\)/);
  // The retry carries the masked draft back, never the restored one.
  assert.match(retryWire, /Your A in AP English Language and Composition/);
});

test("chat appends a visible correction when the retry still misstates the record", async () => {
  const token = await registerWithProfile("fidelity-footnote");
  const wrong = "Your A in AP English Language and Composition is solid, and you scored a 5 on AP Statistics with a 3.9 GPA.";
  const stillWrong = "Your A in AP English Language and Composition is solid.";
  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      messages: [{ role: "user", content: `Summarize my strengths. MOCKREPLY:${b64(wrong)}: MOCKRETRY:${b64(stillWrong)}:` }],
      request_id: "fidelity-footnote-1",
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.equal(turn.data._meta.profileFidelity?.resolved, "footnote");
  // Three contradictions in the draft, one left after the retry — the answer
  // with fewer errors wins, and the survivor is called out.
  assert.equal(turn.data._meta.profileFidelity.contradictions.length, 3);
  assert.match(turn.data.answer, /^Your A in AP English Language and Composition is solid\./);
  assert.match(turn.data.answer, /_Correction from your saved profile/);
  assert.match(turn.data.answer, /AP English Language and Composition: recorded grade B\+ \(the reply said A\)/);
  assert.doesNotMatch(turn.data.answer, /AP Statistics exam/);
});

test("a deadline question about a school with official data goes to the model, not the canned non-answer", async () => {
  const token = await registerWithProfile("deadline-lookup");
  const reply = "Stanford's Restrictive Early Action deadline is November 1 [Source: Stanford University Common Data Set].";
  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      system: "You are the COLLEGE FIT specialist for students ages 14-18.",
      messages: [{ role: "user", content: `When is Stanford University's early application deadline? MOCKREPLY:${b64(reply)}:` }],
      request_id: "deadline-lookup-1",
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  // This used to short-circuit into the rules engine and answer
  // "No deadline date available." — the school-name extractor was handed the
  // question string and found nothing. With no cached dates the question now
  // reaches the model with the VERIFIED DATA block.
  assert.equal(turn.data._meta.deterministic, false);
  assert.equal(turn.data._meta.verifiedData, true);
  assert.equal(turn.data.answer, reply);
  assert.doesNotMatch(turn.data.answer, /No deadline date available/);
});

test("the College Fit double-check compares the stored read with live sources and reaches the chat", async () => {
  const token = await registerWithProfile("fit-verify");
  // A fit read for Stanford comes from the stored Common Data Set.
  const fit = await request("POST", "/api/positioning/targets", {
    token,
    body: { targets: [{ schoolName: "Stanford University" }], major: "Computer Science" },
  });
  assert.equal(fit.status, 200, `${JSON.stringify(fit.data)}\n${serverOutput}`);
  const read = fit.data.targets[0];
  assert.ok(read.overallPositioningLabel);

  // The mock Scorecard answers 49% / 1330–1490 for every school, so the live
  // IPEDS numbers differ from the stored CDS; the official site is unreachable
  // in tests, so the policy check is unavailable rather than invented.
  const verify = await request("POST", "/api/positioning/verify", {
    token,
    body: { schoolName: "Stanford University", major: "Computer Science" },
  });
  assert.equal(verify.status, 200, `${JSON.stringify(verify.data)}\n${serverOutput}`);
  assert.equal(verify.data.verdict, "discrepancies_found");
  assert.equal(verify.data.cached, false);
  const byField = Object.fromEntries(verify.data.checks.map((c) => [c.field, c]));
  assert.equal(byField.acceptance_rate.status, "differs");
  assert.equal(byField.acceptance_rate.live, "49%");
  assert.match(byField.acceptance_rate.used, /^\d+(\.\d)?%$/);
  assert.equal(byField.test_policy.status, "unavailable");
  assert.ok(verify.data.sources.some((s) => s.kind === "college_scorecard"));
  assert.equal(verify.data.positioning.overallPositioningLabel, read.overallPositioningLabel);
  // A validated CDS as new as Scorecard's data keeps its numbers: no re-score.
  assert.equal(verify.data.recomputed, null);

  const again = await request("POST", "/api/positioning/verify", { token, body: { schoolName: "Stanford University" } });
  assert.equal(again.status, 200);
  assert.equal(again.data.cached, true);

  // The chat now sees the same read and the verdict.
  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      system: "You are the COLLEGE FIT specialist for students ages 14-18.",
      messages: [{ role: "user", content: `How do I stand at Stanford University? MOCKREPLY:${b64("You are a reach there.")}:` }],
      request_id: "fit-verify-chat-1",
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  const calls = loggedModelCalls();
  const wire = JSON.stringify(calls[calls.length - 1].messages);
  assert.match(wire, new RegExp(`College Fit read for THIS student \\(computed \\d{4}-\\d{2}-\\d{2} from validated Common Data Set\\): ${read.overallPositioningLabel}`));
  assert.match(wire, /College Fit double-check \(\d{4}-\d{2}-\d{2}\): live sources differ from the stored data — Admit rate: fit used \d+(?:\.\d)?%, live 49%/);
});

test("a document block reaches the model as its full extracted text, and the profile check yields to the document", async () => {
  const token = await registerWithProfile("attachment-inline");
  const transcript = "Official Transcript\nGrade Level: 11\nAP English Language and Composition  A\nAP Statistics  A\nCredits earned: 2.0\n";
  // The document says A for AP English; the saved profile says B+. On an
  // attachment turn the document is the ground truth, so no correction.
  const reply = "Your A in AP English Language and Composition on this transcript is strong.";
  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "text/plain", data: Buffer.from(transcript, "utf8").toString("base64") } },
          { type: "text", text: `The student uploaded "transcript.txt". Summarize the grades. MOCKREPLY:${b64(reply)}:` },
        ],
      }],
      request_id: "attachment-inline-1",
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.equal(turn.data._meta.attachmentTurn, true);
  assert.equal(turn.data._meta.attachmentsInlined, 1);
  assert.equal(turn.data._meta.profileFidelity, null);
  assert.equal(turn.data.answer, reply);
  const calls = loggedModelCalls();
  const wire = JSON.stringify(calls[calls.length - 1].messages);
  // The text-only adapter used to send "[non-text block omitted]" — the
  // student's file was simply absent and the model narrated a truncated one.
  assert.match(wire, /\[Attached document — full extracted text, \d+ characters\]/);
  assert.match(wire, /AP Statistics {2}A/);
  assert.match(wire, /Credits earned: 2\.0/);
  assert.doesNotMatch(wire, /non-text block omitted/);
});

test("attached-file text does not steer the topic classifier, and utility calls bypass the regulated gate", async () => {
  const token = await registerWithProfile("preface-classify");
  // The transcript's own lines mention financial aid; the question is not
  // about aid. Classification must run on the question only.
  const preface = "[Attached files — read carefully and reference in your answer; 1 text file(s)]\n\n═══ FILE: transcript.txt (1 KB) ═══\n```\nOfficial Transcript\nFinancial aid office: see FAFSA eligibility notes\nAP Statistics  A\n```\n[End of attached files]\n\n";
  const reply = "Your AP Statistics grade on this transcript is an A.";
  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      messages: [{ role: "user", content: `${preface}Summarize the courses on this transcript. MOCKREPLY:${b64(reply)}:` }],
      request_id: "preface-classify-1",
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.equal(turn.data._meta.deterministic, false);
  assert.notEqual(turn.data._meta.topicType, "regulated");
  assert.equal(turn.data._meta.attachmentTurn, true);
  assert.equal(turn.data.answer, reply);

  // The client's output validator reviews drafts that may mention aid or
  // deadlines. It used to get the canned "no verified source" gate reply
  // instead of a model verdict, which the client could not parse as JSON.
  const validator = await request("POST", "/api/chat", {
    token,
    body: {
      system: "You validate responses for a college counseling app. Respond JSON only.",
      messages: [{ role: "user", content: `Review:\n---\nFile your FAFSA by the financial aid deadline; verify the official deadline on StudentAid.gov.\n---\nMOCKREPLY:${b64('{"passed":true,"issues":[]}')}:` }],
      request_id: "preface-classify-2",
    },
  });
  assert.equal(validator.status, 200, JSON.stringify(validator.data));
  assert.equal(validator.data._meta.deterministic, false);
  assert.equal(validator.data.answer, '{"passed":true,"issues":[]}');
  assert.doesNotMatch(validator.data.answer, /verified official source/);
});

test("transcript import accepts already-extracted text from the chat card", async () => {
  const token = await registerWithProfile("transcript-text");
  const r = await request("POST", "/api/students/transcript-import", {
    token,
    body: { text: "Official Transcript\nAP Calculus BC   A\n", filename: "transcript.txt" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.courseCount, 1);
  assert.equal(r.data.courses.junior[0].name, "AP Calculus BC");
  const missing = await request("POST", "/api/students/transcript-import", { token, body: { filename: "x.txt" } });
  assert.equal(missing.status, 400);
});

test("chat grounds a college question in the VERIFIED DATA block", async () => {
  const token = await registerWithProfile("verified-data");
  const reply = "Stanford's acceptance rate is 3.9% [Source: NCES IPEDS, data year 2023], so treat it as a reach.";
  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      system: "You are the COLLEGE FIT specialist for students ages 14-18.",
      messages: [{ role: "user", content: `How do I fit Stanford University? MOCKREPLY:${b64(reply)}:` }],
      request_id: "verified-data-1",
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.equal(turn.data._meta.verifiedData, true);
  assert.equal(turn.data._meta.profileFidelity, null);
  const calls = loggedModelCalls();
  const wire = JSON.stringify(calls[calls.length - 1].messages);
  assert.match(wire, /VERIFIED DATA \(the ONLY statistics you may cite/);
  // Figures come from whichever baseline row the seed left for Stanford
  // (bundled or IPEDS-generated), so assert the shape, not the numbers.
  assert.match(wire, /- Stanford University \(CA\): acceptance rate \d+(?:\.\d)?%; SAT middle 50% \d{3,4}–\d{3,4}/);
  assert.match(wire, /\[Source: NCES IPEDS, data year \d{4}\]/);
  // Dollar figures must survive the provider redaction (no "$" → no
  // [ANNUAL_INCOME_xx] token in the model's view).
  assert.match(wire, /tuition in-state [\d,]+ USD/);
  assert.doesNotMatch(wire, /ANNUAL_INCOME/);
  // The stored Common Data Set for Stanford rides along with its C7 factors.
  assert.match(wire, /Stanford University Common Data Set[^"]*validated/);
  assert.match(wire, /admissions factors rated very important: [^"]*course rigor/);
  // Stable-prefix order for provider prompt caching: fixed rules, then the
  // client's specialist prompt, then the profile, and the per-question
  // VERIFIED DATA block last. The per-question block used to sit before the
  // specialist prompt, so the cacheable prefix ended at the profile.
  const systemText = String(calls[calls.length - 1].messages[0]?.content?.[0]?.text || calls[calls.length - 1].messages[0]?.content || "");
  const at = (needle) => { const i = systemText.indexOf(needle); assert.ok(i >= 0, `system prompt lacks ${needle}`); return i; };
  assert.ok(at("STAY ON THEME") < at("PROFILE FIDELITY"));
  assert.ok(at("PROFILE FIDELITY") < at("COLLEGE FIT specialist"));
  // "STUDENT PROFILE" alone also appears inside the fidelity rule; the block
  // itself opens with the parenthetical.
  assert.ok(at("COLLEGE FIT specialist") < at("STUDENT PROFILE (the student's saved record"));
  assert.ok(at("STUDENT PROFILE (the student's saved record") < at("VERIFIED DATA (the ONLY statistics"));
});

test("college fit falls back to College Scorecard stats when CDS and baselines have nothing", async () => {
  const token = await registerStudent("fit-scorecard");
  const synced = await request("POST", "/api/students/sync", {
    token,
    body: {
      profile: { gpa: { unweighted: 3.7 }, courses: [{ name: "AP Physics 1", type: "ap", grade: "A" }], testScores: [{ test: "sat", totalScore: 1400 }], apScores: [] },
      activities: [],
      majorInterest: "Computer Science",
      goals: [],
    },
  });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));

  // The fallback target must be a school with no CDS record and no baseline
  // profile. Each subject so far has aged out as coverage grew: Stony Brook
  // gained a CDS record, then Oberlin gained a generated IPEDS baseline (the
  // top-100/top-50/state-top-10 set from `npm run generate:colleges`). Knox
  // College sits outside all of those, so the Scorecard fallback is what
  // must supply its stats.
  const fit = await request("POST", "/api/positioning/targets", {
    token,
    body: { targets: [{ schoolName: "Knox College" }], searchCds: false },
  });
  assert.equal(fit.status, 200, `${JSON.stringify(fit.data)}\n${serverOutput}`);
  const target = (fit.data.targets || [])[0];
  assert.ok(target, JSON.stringify(fit.data));
  assert.match(JSON.stringify(target), /college_scorecard/);
});

test("the context appendix does not poison chat topic classification", async () => {
  const token = await registerStudent("appendix-chat");
  for (const consentType of ["data_processing", "ai_interaction", "cross_border_transfer"]) {
    const consent = await request("POST", "/api/consent/grant", {
      token,
      body: { consentType, grantedBy: "student" },
    });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }

  // Regression: the client appends calendar reference data after the
  // question. "FAFSA opens 2026-10-01" inside it classified EC questions as
  // regulated aid lookups, decorating replies with StudentAid.gov actions.
  const content = [
    "What extracurriculars should I add next for a computer science major?",
    "",
    "[Context appendix — reference data for the assistant; not part of the student's question]",
    "Typical US deadlines — EA/ED 2026-11-01; RD 2027-01-01; FAFSA opens 2026-10-01.",
    "[End context appendix]",
  ].join("\n");
  const turn = await request("POST", "/api/chat", {
    token,
    body: { messages: [{ role: "user", content }], request_id: "appendix-chat-1" },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.equal(turn.data._meta.deterministic, false);
  assert.equal(turn.data.topic_type, "coaching");
  assert.doesNotMatch(String(turn.data.answer), /eligibility item/i);
});

test("uploaded-file context survives a thread reload via model_content", async () => {
  const token = await registerStudent("file-context");
  const threadId = await createThread(token);

  // The display copy is the bare question; the model-facing copy carries the
  // extracted file text. Reopening the thread must return both — losing
  // model_content is exactly the "files disappear after updates" bug.
  const display = "Please review my attached activity resume.";
  const modelCopy = "[Attached files — 1 text file(s)]\n═══ FILE: resume.txt (2 KB) ═══\nRobotics captain, founded coding club, VEX finalist.\n[End of attached files]\n\n" + display;
  const appended = await request("POST", `/api/students/threads/${threadId}/messages`, {
    token,
    body: { role: "user", content: display, attachmentName: "resume.txt", modelContent: modelCopy },
  });
  assert.equal(appended.status, 200, JSON.stringify(appended.data));

  const reopened = await request("GET", `/api/students/threads/${threadId}`, { token });
  assert.equal(reopened.status, 200);
  const message = reopened.data.messages[0];
  assert.equal(message.content, display);
  assert.equal(message.attachment_name, "resume.txt");
  assert.match(String(message.model_content), /VEX finalist/);
});

test("strategy questions about deadlines and admit rates reach the model instead of the no-source gate", async () => {
  const token = await registerWithProfile("gate-strategy");
  for (const [question, id] of [
    ["Should I apply early decision or early action to Stanford University, and how does the deadline change my odds?", "gate-strategy-1"],
    ["How much does the acceptance rate matter when I build my college list?", "gate-strategy-2"],
  ]) {
    const turn = await request("POST", "/api/chat", {
      token,
      body: { messages: [{ role: "user", content: `${question} MOCKREPLY:${b64("Here is how to think about it.")}:` }], request_id: id },
    });
    assert.equal(turn.status, 200, JSON.stringify(turn.data));
    assert.match(turn.data.answer, /Here is how to think about it/, question);
    assert.notEqual(turn.data._meta?.noVerifiedSource, true, question);
  }
});

// A school the chat can recognize (an alias, or a baseline name) for which
// the server holds no admissions statistics. The baseline is seeded from the
// bundled profile list in CI and from a full IPEDS import on a developer
// machine, so the choice is made against the test database itself.
function schoolWithoutStats() {
  const db = new Database(path.join(testDataDir, "operational.db"), { readonly: true });
  try {
    const stats = db.prepare("SELECT acceptance_rate, sat_25 FROM baseline_colleges WHERE name = ?");
    for (const [alias, canonical] of [
      ["NJIT", "New Jersey Institute of Technology"],
      ["WPI", "Worcester Polytechnic Institute"],
      ["RPI", "Rensselaer Polytechnic Institute"],
      ["UCF", "University of Central Florida"],
      ["FSU", "Florida State University"],
      ["ASU", "Arizona State University"],
    ]) {
      const row = stats.get(canonical);
      if (!row || (row.acceptance_rate == null && row.sat_25 == null)) return { mention: alias, canonical };
    }
    const row = db.prepare("SELECT name FROM baseline_colleges WHERE acceptance_rate IS NULL AND sat_25 IS NULL AND name LIKE '% %' AND name NOT LIKE '%-%' AND length(name) >= 10 ORDER BY name LIMIT 1").get();
    return row ? { mention: row.name, canonical: row.name } : null;
  } finally {
    db.close();
  }
}

test("a pure deadline lookup about a school with no data gets an honest, useful answer, not the old refusal", async (t) => {
  const school = schoolWithoutStats();
  if (!school) return t.skip("every recognizable school in this database has statistics");
  const token = await registerWithProfile("gate-lookup");
  const turn = await request("POST", "/api/chat", {
    token,
    body: { messages: [{ role: "user", content: `When is ${school.mention}'s regular decision deadline?` }], request_id: "gate-lookup-1" },
  });
  assert.equal(turn.status, 200, JSON.stringify(turn.data));
  assert.equal(turn.data._meta?.noVerifiedSource, true, JSON.stringify(turn.data._meta));
  assert.ok(turn.data.answer.includes(school.canonical), turn.data.answer);
  assert.match(turn.data.answer, /November 1/);
  assert.doesNotMatch(turn.data.answer, /verified official source to answer this regulated question/);
  // The official pages were tried first (the test network has no such site).
  assert.ok(["failed", "skipped", "timeout", "error"].includes(turn.data._meta.onDemandRead), JSON.stringify(turn.data._meta));
});

test("a statistics lookup about a school with no stored data is answered from the College Scorecard", async (t) => {
  const school = schoolWithoutStats();
  if (!school) return t.skip("every recognizable school in this database has statistics");
  const token = await registerWithProfile("gate-stats");
  const turn = await request("POST", "/api/chat", {
    token,
    body: { messages: [{ role: "user", content: `What is the acceptance rate at ${school.mention}?` }], request_id: "gate-stats-1" },
  });
  assert.equal(turn.status, 200, JSON.stringify(turn.data));
  assert.equal(turn.data._meta?.deterministic, true, JSON.stringify(turn.data._meta));
  assert.equal(turn.data._meta?.onDemandRead, "ok");
  assert.match(turn.data.answer, /College Scorecard/);
  assert.match(turn.data.answer, /49%/);
  assert.match(turn.data.answer, /1330/);
});

test("a dates answer says when the plan the student asked for is not on the pages read", async () => {
  // A scouted snapshot with an Early Action date only, as NJIT's site gives.
  const db = new Database(path.join(testDataDir, "operational.db"));
  try {
    db.prepare(`INSERT OR REPLACE INTO admissions_policy_snapshots (slug, school_name, unit_id, homepage, checked_at, changed_at, content_hash, pages_json, policy_json, check_count)
      VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, 1)`).run(
      "worcester-polytechnic-institute", "Worcester Polytechnic Institute", "https://www.wpi.edu/", "2026-09-05T00:00:00.000Z", "test-hash", "[]",
      JSON.stringify({ cycle: "2026-27", testPolicy: null, applicationFee: null, deadlines: { early_action: { date: "2026-11-01", sourceUrl: "https://www.wpi.edu/admissions/undergraduate/apply", evidence: "Early Action: November 1" } } }),
    );
  } finally {
    db.close();
  }
  const token = await registerWithProfile("gate-plan");
  const turn = await request("POST", "/api/chat", {
    token,
    body: { messages: [{ role: "user", content: "When is WPI's regular decision deadline?" }], request_id: "gate-plan-1" },
  });
  assert.equal(turn.status, 200, JSON.stringify(turn.data));
  assert.equal(turn.data._meta?.deterministic, true, JSON.stringify(turn.data._meta));
  assert.match(turn.data.answer, /Worcester Polytechnic Institute \(2026-27 cycle\): Early Action: 2026-11-01/);
  assert.match(turn.data.answer, /do not state a Regular Decision deadline for Worcester Polytechnic Institute \(some schools admit on a rolling basis after Early Action\)/);
  // A strategy question about the same school goes to the model, dates in context.
  const strategy = await request("POST", "/api/chat", {
    token,
    body: { messages: [{ role: "user", content: `Should I apply early action to WPI? MOCKREPLY:${b64("Early action there is non-binding, so yes if your application is ready.")}:` }], request_id: "gate-plan-2" },
  });
  assert.equal(strategy.status, 200, JSON.stringify(strategy.data));
  assert.notEqual(strategy.data._meta?.deterministic, true);
  assert.match(strategy.data.answer, /non-binding/);
  const calls = loggedModelCalls();
  assert.match(JSON.stringify(calls[calls.length - 1].messages), /Early Action deadline 2026-11-01/);
});

test("persisted turns build the thread graph and a later question recalls them as THREAD MEMORY", async () => {
  const token = await registerWithProfile("thread-graph");
  const thread = await createThread(token, "Brown plans");
  await appendUserMessage(token, thread, "Should I apply early decision to Brown University?");
  const answer = "Brown University's early decision round is binding, so commit only if it is your clear first choice and the net price calculator works for your family. Your AP Calculus BC grade and the Robotics Club captaincy are strong signals for an applied-math applicant.";
  const appended = await request("POST", `/api/students/threads/${thread}/messages`, { token, body: { role: "assistant", content: answer } });
  assert.equal(appended.status, 200, JSON.stringify(appended.data));
  assert.ok(appended.data.threadGraph?.factId, JSON.stringify(appended.data));
  assert.ok(appended.data.threadGraph.entities >= 2, JSON.stringify(appended.data));

  // A new thread about the same school: the earlier advice comes back as a
  // few lines of THREAD MEMORY inside the system prompt, placed after the
  // profile and before the per-question VERIFIED DATA block.
  const turn = await request("POST", "/api/chat", {
    token,
    body: {
      system: "You are the COLLEGE FIT specialist for students ages 14-18.",
      messages: [{ role: "user", content: "Remind me what we decided about Brown University's binding plan?" }],
      request_id: "thread-graph-1",
    },
  });
  assert.equal(turn.status, 200, `${JSON.stringify(turn.data)}\n${serverOutput}`);
  assert.equal(turn.data._meta.threadMemory, 1);
  const calls = loggedModelCalls();
  const systemText = String(calls[calls.length - 1].messages[0]?.content?.[0]?.text || calls[calls.length - 1].messages[0]?.content || "");
  assert.match(systemText, /THREAD MEMORY \(earlier counseling with this student/);
  // Labels: schools, then plans, then the student's own activities. "AP
  // Calculus BC" in the answer must not link Boston College.
  assert.match(systemText, /\[brown university; early decision; robotics club\] Asked: Should I apply early decision to Brown University\? → Advised: Brown University's early decision round is binding/);
  assert.doesNotMatch(systemText, /boston college/i);
  assert.ok(systemText.indexOf("STUDENT PROFILE (the student's saved record") < systemText.indexOf("THREAD MEMORY"));
  assert.ok(systemText.indexOf("THREAD MEMORY") < systemText.indexOf("VERIFIED DATA (the ONLY statistics"));

  // The same question sent with that turn in the verbatim history does not
  // get it a second time as memory.
  const inHistory = await request("POST", "/api/chat", {
    token,
    body: {
      system: "You are the COLLEGE FIT specialist for students ages 14-18.",
      messages: [
        { role: "user", content: "Should I apply early decision to Brown University?" },
        { role: "assistant", content: answer },
        { role: "user", content: "And what is Brown University's deadline for that plan?" },
      ],
      request_id: "thread-graph-2",
    },
  });
  assert.equal(inHistory.status, 200, `${JSON.stringify(inHistory.data)}\n${serverOutput}`);
  if (inHistory.data._meta?.deterministic !== true) assert.equal(inHistory.data._meta.threadMemory, 0);

  // A hard delete of the thread forgets its memory.
  const removed = await request("DELETE", `/api/students/threads/${thread}?hard=1`, { token });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  const after = await request("POST", "/api/chat", {
    token,
    body: {
      system: "You are the COLLEGE FIT specialist for students ages 14-18.",
      messages: [{ role: "user", content: "What did we decide about Brown University's binding plan?" }],
      request_id: "thread-graph-3",
    },
  });
  assert.equal(after.status, 200, `${JSON.stringify(after.data)}\n${serverOutput}`);
  assert.equal(after.data._meta.threadMemory, 0);
});
