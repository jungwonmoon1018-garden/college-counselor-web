// The calendar context on Feb 3, 2027, when two cycles are live at once:
// 2027-28 is the planning cycle (next fall's applications) and 2026-27 is
// closing (late regular deadlines, decisions and the May 1 deposit still
// ahead, and the seniors still in it). The server runs on a fixed clock
// (tests/helpers/fixed-clock.mjs), so the file passes on any real date;
// sessions and every date the route reads are the server's JS clock, never
// SQLite's datetime('now').
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cycleDate } from "../shared/admissions-cycle.js";

const FIXED_NOW = "2027-02-03T17:00:00Z";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FETCH_MOCK = pathToFileURL(path.join(__dirname, "helpers", "mock-openrouter-fetch.mjs")).href;
const CLOCK = pathToFileURL(path.join(__dirname, "helpers", "fixed-clock.mjs")).href;
// A committed Common Data Set whose regular deadline falls after Feb 1, read
// from the file so a refreshed document does not break the pin.
const AUSTIN = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "tools", "cds-cache", "parsed", "austin-college.json"), "utf8"));
const RD_MMDD = AUSTIN.extras.dates.regularClosing.mmdd;

let baseUrl;
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
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function registerStudent(label, grade) {
  const result = await request("POST", "/api/students/register", {
    body: {
      email: `${label}-${Math.random().toString(36).slice(2)}@example.test`,
      password: "correct horse battery staple",
      grade,
      state: "TX",
      schoolDomain: "example.edu",
      majorInterest: "Biology",
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.token;
}

before(async () => {
  const port = await freePort();
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "college-counselor-route-tests-"));
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["--import", CLOCK, "--import", FETCH_MOCK, "server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      FIXED_NOW,
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
      TEST_OPENROUTER_CALL_LOG: path.join(testDataDir, "openrouter-calls.jsonl"),
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

const austinEntry = (cal) => cal.data.schools.find((s) => s.school === "Austin College");

// The CDS fallback placed every date in the planning cycle, a year after a
// senior's own: her March 1 regular deadline, still four weeks away, came
// back as 2028-03-01 and the client dropped it as another cycle's.
test("a senior's Common Data Set dates land in her own, closing cycle after Feb 1", async () => {
  const token = await registerStudent("cycle-senior", 12);
  const cal = await request("POST", "/api/calendar/context", { token, body: { targetSchools: ["Austin College"], research: false } });
  assert.equal(cal.status, 200, JSON.stringify(cal.data));
  assert.equal(cal.data.today, "2027-02-03", "the server runs on the fixed clock");
  assert.equal(cal.data.studentCycle.startYear, 2026, JSON.stringify(cal.data.studentCycle));
  const entry = austinEntry(cal);
  assert.equal(entry?.source, "cds", `${JSON.stringify(cal.data.schools)}\n${serverOutput.slice(-2000)}`);
  assert.equal(entry.cycle, "2026-27");
  assert.equal(entry.deadlines.rd, cycleDate(2026, Number(RD_MMDD.slice(0, 2)), Number(RD_MMDD.slice(3))));
});

test("a junior's Common Data Set dates stay in the planning cycle", async () => {
  const token = await registerStudent("cycle-junior", 11);
  const cal = await request("POST", "/api/calendar/context", { token, body: { targetSchools: ["Austin College"], research: false } });
  assert.equal(cal.status, 200, JSON.stringify(cal.data));
  assert.equal(cal.data.studentCycle.startYear, 2027, JSON.stringify(cal.data.studentCycle));
  const entry = austinEntry(cal);
  assert.equal(entry?.source, "cds", JSON.stringify(cal.data.schools));
  assert.equal(entry.cycle, "2027-28");
  assert.equal(entry.deadlines.rd, cycleDate(2027, Number(RD_MMDD.slice(0, 2)), Number(RD_MMDD.slice(3))));
});

// The calendar the model reads outlined only the planning cycle, so a
// senior asking in February was given an enrollment deposit of May 1, 2028.
test("the calendar names the closing cycle and its May 1 deposit beside the planning cycle", async () => {
  const token = await registerStudent("cycle-calendar", 12);
  const cal = await request("POST", "/api/calendar/context", { token, body: { targetSchools: [], research: false } });
  assert.equal(cal.status, 200, JSON.stringify(cal.data));
  const { calendar } = cal.data;
  assert.equal(calendar.cycleStartYear, 2027);
  assert.equal(calendar.typicalISO.nationalDepositDeadline, "2028-05-01");
  assert.equal(calendar.closingCycle?.cycle, "2026-27", JSON.stringify(calendar));
  assert.equal(calendar.closingCycle.nationalDepositDeadline, "May 1 2027");
  // The phase line is what the chat's calendar preamble prints today.
  assert.match(calendar.phase, /2026-27 cycle is closing/);
  assert.match(calendar.phase, /May 1 2027/);
});
