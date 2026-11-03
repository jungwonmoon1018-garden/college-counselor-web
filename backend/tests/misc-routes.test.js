// Route tests for the "misc" stability fixes of 2026-11-03: the counselor,
// CDS and EC surfaces that answer 410, and the cache routes a student can
// reach. The bootstrap is the one in council-naming-deadlines-routes.test.js.
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
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
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
    const consent = await request("POST", "/api/consent/grant", { token, body: { consentType, grantedBy: "student", locale: "en" } });
    assert.equal(consent.status, 200, JSON.stringify(consent.data));
  }
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

// Each with the method its removed handler used, so a revived handler for
// that method (registered ahead of the tombstone) would show up here.
for (const [method, endpoint, body] of [
  ["POST", "/api/ec/competitions/search", { query: "USACO" }],
  ["GET", "/api/ec/cache-memory"],
  ["GET", "/api/ec/prestige/USA%20Computing%20Olympiad"],
  ["POST", "/api/ec/prestige/recompute", { studentId: 1 }],
  ["DELETE", "/api/ec/component-cache", { factor: "selectivity" }],
  ["GET", "/api/cds/canonical/stanford-university.xlsx"],
  ["GET", "/api/cds/canonical/export-all"],
  ["POST", "/api/cds/ingest", {}],
  ["POST", "/api/admin/seasonal-research/run", {}],
]) {
  test(`${method} ${endpoint} answers 410`, async () => {
    const result = await request(method, endpoint, { body });
    assert.equal(result.status, 410, JSON.stringify(result.data));
  });
}

// The sidebar's "Clear cached college values" said it cleared this
// account's entries, and the route deleted every school's values read for
// every student (ui-8). A student account now clears nothing shared, and a
// re-read of one school that fails keeps that school's good row.
test("a student cannot clear the shared college-values cache, and a failed re-read keeps the row", async () => {
  const token = await registerStudent("values-cache");
  await grantConsents(token);
  const db = new Database(path.join(testDataDir, "operational.db"));
  const fetchedAt = "2026-10-01T00:00:00.000Z";
  const payload = (name) => JSON.stringify({ displayName: name, slug: name.toLowerCase().replace(/\W+/g, "-"), values: [{ theme: "Service", summary: "s", evidence: "e" }], sourceUrl: "https://example.edu/mission", extractedAt: fetchedAt });
  try {
    const put = db.prepare("INSERT OR REPLACE INTO college_research_cache (cache_key, kind, slug, display_name, payload_json, fetched_at) VALUES (?, 'values', ?, ?, ?, ?)");
    put.run("values:misc-alpha-college", "misc-alpha-college", "Misc Alpha College", payload("Misc Alpha College"), fetchedAt);
    put.run("values:misc-beta-college", "misc-beta-college", "Misc Beta College", payload("Misc Beta College"), fetchedAt);
    const rows = () => db.prepare("SELECT cache_key, fetched_at FROM college_research_cache WHERE cache_key LIKE 'values:misc-%' ORDER BY cache_key").all();

    const cleared = await request("DELETE", "/api/colleges/values", { token });
    assert.equal(cleared.status, 410, JSON.stringify(cleared.data));
    assert.equal(cleared.data.code, "values_cache_clear_removed");
    assert.equal(rows().length, 2, "both schools' rows survive a student's clear");

    // A forced re-read of one school whose site cannot be read (the mock
    // answers no school site) fails and leaves both rows as they were.
    const reread = await request("POST", "/api/colleges/values", { token, body: { collegeName: "Misc Alpha College", force: true } });
    assert.notEqual(reread.status, 200, JSON.stringify(reread.data));
    assert.deepEqual(rows().map((r) => r.fetched_at), [fetchedAt, fetchedAt]);
  } finally {
    db.close();
  }
});
