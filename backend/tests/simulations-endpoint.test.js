import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, "..");
const BASE = "http://localhost:3101";
const SIM_BASE = "http://localhost:3102";
const TEST_DATA_DIR = path.join(PROJECT_ROOT, "data", "simulations-endpoint-test");
const TEST_DB_PATH = path.join(TEST_DATA_DIR, "counselor.db");
const TEST_SIM_PROFILE_DB = path.join(TEST_DATA_DIR, "simulated-profiles.endpoint.test.db");
const TEST_SIM_VECTOR_DB = path.join(TEST_DATA_DIR, "simulated-vectors.endpoint.test.db");

function clean() {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}

// Up to a minute (see council-naming-deadlines-routes.test.js).
async function waitFor(url, proc, outputRef) {
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode != null) throw new Error(`Process exited before ${url}\n${outputRef()}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}\n${outputRef()}`);
}

async function req(method, urlPath, body = null, headers = {}) {
  const opts = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${urlPath}`, opts);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// A request straight to the sidecar, as the server makes it.
async function sim(method, urlPath, { token = "endpoint-sim-token" } = {}) {
  const headers = token ? { "x-simulation-internal-token": token } : {};
  const res = await fetch(`${SIM_BASE}${urlPath}`, { method, headers });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

let serverOutput = "";

async function withServers(fn) {
  clean();
  let sidecarOutput = "";
  serverOutput = "";
  const sidecar = spawn(process.execPath, ["simulation-sidecar.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATA_DIR: TEST_DATA_DIR,
      SIM_PORT: "3102",
      SIM_INTERNAL_TOKEN: "endpoint-sim-token",
      SIM_PROFILE_DB_PATH: TEST_SIM_PROFILE_DB,
      SIM_VECTOR_DB_PATH: TEST_SIM_VECTOR_DB,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  sidecar.stdout.on("data", c => { sidecarOutput += c.toString(); });
  sidecar.stderr.on("data", c => { sidecarOutput += c.toString(); });
  try {
    await waitFor(`${SIM_BASE}/health`, sidecar, () => sidecarOutput);

    const server = spawn(process.execPath, ["server.js"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PORT: "3101",
        NODE_ENV: "test",
        DATA_DIR: TEST_DATA_DIR,
        DB_PATH: TEST_DB_PATH,
        COUNSELOR_PASS: "testpass",
        SCORECARD_API_KEY: "",
        SIM_URL: SIM_BASE,
        SIM_INTERNAL_TOKEN: "endpoint-sim-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", c => { serverOutput += c.toString(); });
    server.stderr.on("data", c => { serverOutput += c.toString(); });
    try {
      await waitFor(`${BASE}/api/health`, server, () => serverOutput);
      await fn();
    } finally {
      if (server.exitCode == null) {
        server.kill("SIGTERM");
        await Promise.race([new Promise(resolve => server.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
        if (server.exitCode == null) server.kill("SIGKILL"); // a server that will not exit must not hang the runner
      }
    }
  } finally {
    if (sidecar.exitCode == null) {
      sidecar.kill("SIGTERM");
      await Promise.race([new Promise(resolve => sidecar.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
      if (sidecar.exitCode == null) sidecar.kill("SIGKILL"); // a sidecar that will not exit must not hang the runner
    }
    clean();
  }
}

test("simulation proxy creates temporary vectors without changing actual profile", async () => {
  await withServers(async () => {
    const register = await req("POST", "/api/students/register", {
      email: "sim-endpoint@example.com",
      majorInterest: "Computer Science",
      grade: "11",
      password: "simulation endpoint test password",
    });
    assert.equal(register.status, 201);
    const token = register.data.token;
    await delay(1100);

    const sync = await req("POST", "/api/students/sync", {
      profile: {
        gpa: { unweighted: 3.8, weighted: 4.2 },
        courses: [{ name: "AP Calculus AB", type: "ap", grade: "A" }],
        testScores: [{ test: "sat", totalScore: 1450 }],
      },
      activities: [{ name: "Coding Club", role: "Member", description: "Built web apps." }],
      goals: ["Example Tech"],
      majorInterest: "Computer Science",
    }, { Authorization: `Bearer ${token}` });
    assert.equal(sync.status, 200);

    const created = await req("POST", "/api/simulations", {
      profilePatch: {
        gpa: { unweighted: 3.95 },
        testScores: [{ test: "sat", totalScore: 1560 }],
        activities: [{ name: "AI Research", role: "Lead", description: "Published a model evaluation project." }],
      },
    }, { Authorization: `Bearer ${token}` });
    assert.equal(created.status, 201);
    assert.equal(created.data.simulation, true);
    assert.equal(created.data.profile.gpa.unweighted, 3.95);
    assert.ok(created.data.vectors.length >= 1);
    assert.ok(fs.existsSync(TEST_SIM_PROFILE_DB));
    assert.ok(fs.existsSync(TEST_SIM_VECTOR_DB));

    const actual = await req("GET", "/api/students/profile", null, { Authorization: `Bearer ${token}` });
    assert.equal(actual.status, 200);
    assert.equal(actual.data.profile.gpa.unweighted, 3.8);
    assert.equal(actual.data.profile.testScores[0].totalScore, 1450);

    const fetched = await req("GET", `/api/simulations/${created.data.simulationId}`, null, { Authorization: `Bearer ${token}` });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.data.simulationId, created.data.simulationId);

    const deleted = await req("DELETE", `/api/simulations/${created.data.simulationId}`, null, { Authorization: `Bearer ${token}` });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.deleted, true);
  });
});

// Account erasure asks the sidecar to drop the student's scenarios at
// DELETE /students/:id. Erasure called that route before the sidecar had it,
// so every erasure got a 404, logged a warning and left each scenario's base
// profile (the minor's whole profile and narrative) in the sidecar's
// databases until the TTL; the erasure unit test's stub always succeeded and
// could not see it. This runs the real erasure against the real sidecar.
test("deleting an account drops the student's scenarios from the sidecar, and only theirs", async () => {
  await withServers(async () => {
    const students = {};
    for (const label of ["erased", "kept"]) {
      const register = await req("POST", "/api/students/register", {
        email: `sim-erasure-${label}@example.com`,
        majorInterest: "Computer Science",
        grade: "11",
        password: "simulation erasure test password",
      });
      assert.equal(register.status, 201);
      const auth = { Authorization: `Bearer ${register.data.token}` };
      const sync = await req("POST", "/api/students/sync", {
        profile: { gpa: { unweighted: 3.7 }, courses: [], testScores: [] },
        activities: [{ name: "Harbor Tide Tutors", role: "Founder", description: "Tutors kids at the harbor." }],
        goals: [],
        majorInterest: "Computer Science",
      }, auth);
      assert.equal(sync.status, 200);
      const simulationIds = [];
      for (const unweighted of [3.8, 3.9]) {
        const created = await req("POST", "/api/simulations", { profilePatch: { gpa: { unweighted } } }, auth);
        assert.equal(created.status, 201);
        simulationIds.push(created.data.simulationId);
      }
      students[label] = { auth, studentId: register.data.studentId, simulationIds };
    }
    const scenario = (student, id) => sim("GET", `/simulations/${id}?studentId=${encodeURIComponent(student.studentId)}`);
    for (const student of Object.values(students)) {
      for (const id of student.simulationIds) assert.equal((await scenario(student, id)).status, 200);
    }

    // The route answers only the server.
    const unauthenticated = await sim("DELETE", `/students/${encodeURIComponent(students.kept.studentId)}`, { token: null });
    assert.equal(unauthenticated.status, 401);
    assert.equal((await scenario(students.kept, students.kept.simulationIds[0])).status, 200);

    const erased = await req("DELETE", "/api/students", null, students.erased.auth);
    assert.equal(erased.status, 200);
    for (const id of students.erased.simulationIds) assert.equal((await scenario(students.erased, id)).status, 404);
    for (const id of students.kept.simulationIds) assert.equal((await scenario(students.kept, id)).status, 200);
    assert.doesNotMatch(serverOutput, /\[ERASURE\] simulation sidecar delete failed/);

    // Called directly, it says what it removed, and a second call finds nothing.
    const direct = await sim("DELETE", `/students/${encodeURIComponent(students.kept.studentId)}`);
    assert.equal(direct.status, 200);
    assert.equal(direct.data.profiles, 2);
    assert.ok(direct.data.vectors >= 2, JSON.stringify(direct.data));
    assert.deepEqual((await sim("DELETE", `/students/${encodeURIComponent(students.kept.studentId)}`)).data, { profiles: 0, vectors: 0 });
  });
});
