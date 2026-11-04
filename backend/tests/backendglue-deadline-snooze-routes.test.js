// A snoozed deadline sleeps until a date and then counts again. "Snoozed"
// used to have no end: the row left the upcoming and overdue counts for
// good, so a snoozed application deadline never reminded the student again
// (input-4). Every date here is relative to the server's own Anywhere-on-
// Earth today, so the test never depends on the day it runs.
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
import { addCalendarDays, anywhereOnEarthToday } from "../shared/calendar-date.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FETCH_MOCK = path.join(__dirname, "helpers", "mock-openrouter-fetch.mjs");

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
    if (serverProcess?.exitCode != null) throw new Error(`Route-test server exited early (${serverProcess.exitCode}).\n${serverOutput}`);
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
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

async function registerStudent(label) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const result = await request("POST", "/api/students/register", { body: { email, password: "correct horse battery staple", grade: 11 } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.token;
}

async function createDeadline(token, title, dueAt) {
  const created = await request("POST", "/api/students/deadlines", { token, body: { title, dueAt, category: "admissions" } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data.deadline.id;
}

before(async () => {
  const port = await freePort();
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "college-counselor-route-tests-"));
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
      ENCRYPTION_KEY: "cd".repeat(32),
      OPENROUTER_API_KEY: "sk-or-test-openrouter-key",
      SIM_URL: `http://127.0.0.1:${port + 1}`,
      SIM_INTERNAL_TOKEN: "route-test-sidecar-token",
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

test("a snooze with a date sleeps until that date and then counts again", async () => {
  const token = await registerStudent("snooze-date");
  const today = anywhereOnEarthToday();
  const tomorrow = addCalendarDays(today, 1);
  const id = await createDeadline(token, "Scholarship essay", addCalendarDays(today, 3));

  const snoozed = await request("PATCH", `/api/students/deadlines/${id}`, { token, body: { status: "snoozed", snoozeUntil: tomorrow } });
  assert.equal(snoozed.status, 200, JSON.stringify(snoozed.data));
  assert.equal(snoozed.data.deadline.status, "snoozed");
  assert.equal(snoozed.data.deadline.snoozeUntil, tomorrow);

  // Asleep today: out of the counts, shown as snoozed with its date.
  const asleep = await request("GET", "/api/students/deadlines", { token });
  assert.equal(asleep.status, 200, JSON.stringify(asleep.data));
  assert.equal(asleep.data.summary.upcoming, 0);
  assert.equal(asleep.data.deadlines[0].status, "snoozed");
  assert.equal(asleep.data.deadlines[0].snoozeUntil, tomorrow);

  // On the snooze date (the client's own date, which the server accepts
  // while it is today somewhere on Earth) the row is open and counted.
  const awake = await request("GET", `/api/students/deadlines?today=${tomorrow}`, { token });
  assert.equal(awake.status, 200, JSON.stringify(awake.data));
  assert.equal(awake.data.summary.today, tomorrow);
  assert.equal(awake.data.deadlines[0].status, "open");
  assert.equal(Object.hasOwn(awake.data.deadlines[0], "snoozeUntil"), false);
  assert.equal(awake.data.summary.upcoming, 1);
  assert.equal(awake.data.summary.dueIn7, 1);

  // A date alone means a snooze; reopening clears it.
  const byDate = await request("PATCH", `/api/students/deadlines/${id}`, { token, body: { snoozeUntil: addCalendarDays(today, 2) } });
  assert.equal(byDate.status, 200, JSON.stringify(byDate.data));
  assert.equal(byDate.data.deadline.status, "snoozed");
  assert.equal(byDate.data.deadline.snoozeUntil, addCalendarDays(today, 2));
  const reopened = await request("PATCH", `/api/students/deadlines/${id}`, { token, body: { status: "open" } });
  assert.equal(reopened.data.deadline.status, "open");
  const db = new Database(path.join(testDataDir, "operational.db"), { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.prepare("SELECT snooze_until FROM student_deadlines WHERE id = ?").get(id).snooze_until, null);
  } finally {
    db.close();
  }
});

test("a snooze date is held to the due date's rules", async () => {
  const token = await registerStudent("snooze-invalid");
  const today = anywhereOnEarthToday();
  const id = await createDeadline(token, "Housing form", addCalendarDays(today, 10));
  for (const snoozeUntil of [addCalendarDays(today, -1), "2027-02-30", "soon", "20266-01-01", addCalendarDays(today, 365 * 7)]) {
    const refused = await request("PATCH", `/api/students/deadlines/${id}`, { token, body: { status: "snoozed", snoozeUntil } });
    assert.equal(refused.status, 400, `${snoozeUntil}: ${JSON.stringify(refused.data)}`);
    assert.match(refused.data.friendlyMessage, /Pick a date between/);
  }
  const contradiction = await request("PATCH", `/api/students/deadlines/${id}`, { token, body: { status: "done", snoozeUntil: addCalendarDays(today, 2) } });
  assert.equal(contradiction.status, 400, JSON.stringify(contradiction.data));
  const stored = await request("GET", "/api/students/deadlines", { token });
  assert.equal(stored.data.deadlines[0].status, "open", "nothing was written");
});

test("a snooze that names no date ends within a week, never after the due date", async () => {
  const token = await registerStudent("snooze-default");
  const today = anywhereOnEarthToday();
  const far = await createDeadline(token, "Far", addCalendarDays(today, 30));
  const near = await createDeadline(token, "Near", addCalendarDays(today, 3));
  const past = await createDeadline(token, "Past", addCalendarDays(today, -5));
  const snooze = async (id) => (await request("PATCH", `/api/students/deadlines/${id}`, { token, body: { status: "snoozed" } })).data.deadline;
  assert.equal((await snooze(far)).snoozeUntil, addCalendarDays(today, 7));
  assert.equal((await snooze(near)).snoozeUntil, addCalendarDays(today, 3));
  assert.equal((await snooze(past)).snoozeUntil, addCalendarDays(today, 1));

  // A row snoozed before the date existed has nothing to wait for.
  const db = new Database(path.join(testDataDir, "operational.db"), { fileMustExist: true });
  try {
    db.prepare("UPDATE student_deadlines SET snooze_until = NULL WHERE id = ?").run(far);
  } finally {
    db.close();
  }
  const list = await request("GET", "/api/students/deadlines", { token });
  const byTitle = Object.fromEntries(list.data.deadlines.map((d) => [d.title, d]));
  assert.equal(byTitle.Far.status, "open");
  assert.equal(byTitle.Near.status, "snoozed");
});
