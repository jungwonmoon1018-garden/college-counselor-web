// POST /api/students/sync with the score entries the input fixes changed:
// the enhanced ACT composite, the TOEFL 1-6 band and PSAT 8/9 scales, and a
// set-aside entry that keeps the stored version and is named by place.
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

const sync = (token, profile) => request("POST", "/api/students/sync", {
  token,
  body: { profile, activities: [], goals: [], majorInterest: "Computer Science" },
});
const storedProfile = async (token) => (await request("GET", "/api/students/profile", { token })).data.profile;

test("an enhanced ACT composite, a TOEFL band and a PSAT 8/9 score are stored as sent", async () => {
  const token = await registerStudent("input-scales");
  const testScores = [
    // Enhanced ACT: English, Math and Reading average to 35; Science is apart.
    { test: "act", totalScore: 35, sections: { english: 35, math: 36, reading: 34, science: 28 }, date: "2026-09" },
    { test: "toefl", scale: "band", totalScore: 5.5, sections: { reading: 6, listening: 5.5, speaking: 5, writing: 5.5 } },
    { test: "psat", scale: "8/9", totalScore: 900, sections: { readingWriting: 450, math: 450 } },
  ];
  const saved = await sync(token, { gpa: { unweighted: 3.9 }, testScores });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.setAside, []);
  assert.deepEqual((await storedProfile(token)).testScores, testScores);
});

test("a stale bad copy of a stored score keeps the stored one and is named by place", async () => {
  const token = await registerStudent("input-setaside");
  const sat = { test: "sat", totalScore: 1500, sections: { readingWriting: 720, math: 780 }, date: "2026-03" };
  const first = await sync(token, { gpa: { unweighted: 3.9 }, testScores: [sat], classRank: { rank: 5, size: 400 } });
  assert.equal(first.status, 200, JSON.stringify(first.data));

  const stale = await sync(token, {
    gpa: { unweighted: 3.9 },
    testScores: [{ test: "sat", totalScore: 1700, date: "2026-03" }, { test: "toefl", totalScore: 5 }],
    classRank: { rank: 500, size: 400 },
  });
  assert.equal(stale.status, 200, JSON.stringify(stale.data));
  const tests = stale.data.setAside.filter((s) => s.field === "testScores");
  assert.deepEqual(tests.map((s) => [s.reason, s.entries.map((e) => [e.index, e.label, Boolean(e.kept)])]), [
    ["invalid_entry", [[0, "SAT 1700 (2026-03)", true]]],
    ["scale_needed", [[1, "TOEFL 5", false]]],
  ]);
  assert.deepEqual(stale.data.setAside.find((s) => s.field === "classRank"), { field: "classRank", reason: "out_of_range", kept: true });
  const after = await storedProfile(token);
  assert.deepEqual(after.testScores, [sat]);
  assert.equal(after.classRank.rank, 5);
  assert.equal(after.classRank.size, 400);
});
