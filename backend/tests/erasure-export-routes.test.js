// Route test for the student data export: it carries the student's College
// Fit double-check rows. Those are cached in the shared research cache under
// "fitverify:<student id>:<school>:<snapshot>:<version>", one row per
// profile snapshot with the student's fit label and score for that school,
// in a table with no student_id column, so the export left them out while
// erasure (server/student-data.js) deletes them. The export matches the same
// exact prefix erasure does: an id that only starts with this one is
// someone else's.
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
const DATA_DIR_PREFIX = "college-counselor-erasure-export-";

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
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: response.status, data };
}

async function registerStudent(label) {
  const result = await request("POST", "/api/students/register", {
    body: {
      email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      password: "correct horse battery staple",
      grade: 11,
      majorInterest: "Biology",
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return { token: result.data.token, studentId: result.data.studentId };
}

before(async () => {
  const port = await freePort();
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), DATA_DIR_PREFIX));
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
      SCORECARD_API_KEY: "test-scorecard-key",
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
    await Promise.race([
      new Promise((resolve) => serverProcess.once("exit", resolve)),
      delay(5_000),
    ]);
    if (serverProcess.exitCode == null) serverProcess.kill("SIGKILL");
  }
  const resolved = testDataDir ? path.resolve(testDataDir) : "";
  const expectedRoot = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(expectedRoot) && path.basename(resolved).startsWith(DATA_DIR_PREFIX)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("the data export carries the student's College Fit double-check rows, and nobody else's", async () => {
  const student = await registerStudent("fit-export");
  const other = await registerStudent("fit-export-other");
  const fit = JSON.stringify({ verdict: "consistent", original: { label: "Reach", score: 41 } });
  // What the College Fit double-check writes; seeded straight into this
  // test's own database so the export is the only thing under test.
  const db = new Database(path.join(testDataDir, "operational.db"), { fileMustExist: true });
  try {
    const put = db.prepare("INSERT INTO college_research_cache (cache_key, kind, slug, display_name, payload_json, fetched_at) VALUES (?, 'fitverify', 'example-university', 'Example University', ?, '2026-11-03T00:00:00.000Z')");
    for (const snapshot of ["snap-1", "snap-2"]) put.run(`fitverify:${student.studentId}:example-university:${snapshot}:v9`, fit);
    put.run(`fitverify:${other.studentId}:example-university:snap-3:v9`, fit);
    put.run(`fitverify:${student.studentId}0:example-university:snap-4:v9`, fit);
    db.prepare("INSERT INTO college_research_cache (cache_key, kind, slug, display_name, payload_json, fetched_at) VALUES ('values:example-university', 'values', 'example-university', 'Example University', '{}', '2026-11-03T00:00:00.000Z')").run();
  } finally {
    db.close();
  }

  const exported = await request("GET", "/api/students/export", { token: student.token });
  assert.equal(exported.status, 200, JSON.stringify(exported.data));
  const rows = exported.data.operational.college_research_cache;
  assert.ok(Array.isArray(rows), "the export has a college_research_cache section");
  assert.deepEqual(rows.map((row) => row.cache_key).sort(), [
    `fitverify:${student.studentId}:example-university:snap-1:v9`,
    `fitverify:${student.studentId}:example-university:snap-2:v9`,
  ]);
  assert.deepEqual(JSON.parse(rows[0].payload_json), JSON.parse(fit));

  const otherExport = await request("GET", "/api/students/export", { token: other.token });
  assert.deepEqual(otherExport.data.operational.college_research_cache.map((row) => row.cache_key), [`fitverify:${other.studentId}:example-university:snap-3:v9`]);
});
