// The counselor's model page against a running server: what the catalog
// scout found (per price band, ":batch" variants skipped), the two-week
// cadence, a manual check that runs at once, and dismiss / list again.
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
const DAY_MS = 24 * 60 * 60 * 1000;

let baseUrl;
let serverOutput = "";
let serverProcess;
let testDataDir;
let adminCookie = "";
let csrfToken = "";

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

async function admin(method, pathname, body) {
  const headers = { "Content-Type": "application/json", Cookie: adminCookie };
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function modelPage() {
  // The boot scout runs right after the first catalog fetch; wait for it.
  let page;
  for (let attempt = 0; attempt < 50; attempt++) {
    page = await admin("GET", "/api/admin/models");
    if (page.status === 200 && page.data?.catalogScout?.lastRun?.finishedAt) return page;
    await delay(100);
  }
  return page;
}

before(async () => {
  const port = await freePort();
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "college-counselor-admin-models-"));
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
      DESKTOP_BOOTSTRAP_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  serverProcess.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  await waitForHealth();

  // First counselor bootstrap on a fresh installation (loopback, test env).
  const boot = await fetch(`${baseUrl}/api/admin/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "correct horse battery staple" }),
  });
  const bootBody = await boot.json();
  assert.equal(boot.status, 201, JSON.stringify(bootBody));
  adminCookie = String(boot.headers.get("set-cookie") || "").split(";")[0];
  assert.match(adminCookie, /^cc_admin_session=/);
  csrfToken = bootBody.csrfToken;
  assert.ok(csrfToken);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode == null) {
    serverProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => serverProcess.once("exit", resolve)),
      delay(5000),
    ]);
  }
  if (testDataDir) fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("the model page lists what the catalog scout found, by price band, next to the packaged options", async () => {
  const page = await modelPage();
  assert.equal(page.status, 200, JSON.stringify(page.data));
  const discovered = page.data.options.filter((option) => option.discovered);
  assert.deepEqual(
    discovered.map((option) => [option.id, option.tier]).sort(),
    [["google/gemini-3.8-flash", "medium"], ["google/gemma-4-31b-it", "small"], ["openai/gpt-6-astra", "large"], ["qwen/qwen3.8-flash", "small"]],
  );
  assert.ok(!page.data.options.some((option) => option.id.includes(":batch")), "routing variants never become options");
  assert.ok(page.data.options.some((option) => option.id === "google/gemma-4-26b-a4b-it" && !option.discovered), "packaged options stay");
  const small = discovered.find((option) => option.id === "qwen/qwen3.8-flash");
  assert.equal(small.status, "listed");
  assert.equal(small.available, true);
  assert.equal(small.contextLength, 32_768);
  assert.ok(small.createdAt && small.firstSeen, "release and discovery dates travel with the option");
  assert.equal(Math.round(small.pricing.inputPerMTok * 100) / 100, 0.1);

  const scout = page.data.catalogScout;
  assert.equal(scout.enabled, true);
  assert.equal(scout.cadenceDays, 14);
  assert.equal(scout.lastRun.trigger, "boot");
  assert.equal(scout.lastRun.catalogCount, 9);
  assert.equal(scout.lastRun.eligible, 4);
  assert.equal(scout.due, false);
  assert.equal(Date.parse(scout.nextRunAt) - Date.parse(scout.lastRun.finishedAt), 14 * DAY_MS);
});

test("a manual catalog check runs at once; the automatic checks wait for the two-week cadence", async () => {
  const run = await admin("POST", "/api/admin/models/scout/run", {});
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.summary.trigger, "manual");
  assert.equal(run.data.summary.catalogCount, 9);
  assert.equal(run.data.summary.eligible, 4);
  assert.deepEqual(run.data.summary.added, []);
  assert.equal(run.data.summary.kept, 4);
  assert.equal(run.data.summary.pruned, 0);
  assert.equal(run.data.catalogScout.lastRun.trigger, "manual");
  assert.equal(run.data.catalogScout.due, false);
  assert.equal(run.data.options.filter((option) => option.discovered).length, 4);

  assert.match(serverOutput, /\[BOOT\] Model-catalog scout scheduled every 14 day\(s\), checked hourly/);
  assert.match(serverOutput, /\[BOOT\] Admissions-policy scout scheduled every 14 day\(s\), checked hourly/);
  assert.match(serverOutput, /\[BATCH\] Scheduled: model_catalog_scout \(every 1h\)/);
  assert.match(serverOutput, /\[BATCH\] Scheduled: admissions_policy_scout \(every 1h\)/);
  assert.doesNotMatch(serverOutput, /scheduled daily/);
});

test("dismissing a found model hides it from the pickers, survives the next check, and can be undone", async () => {
  const dismissed = await admin("POST", "/api/admin/models/candidates", { modelId: "google/gemini-3.8-flash", status: "dismissed" });
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.data));
  let page = await admin("GET", "/api/admin/models");
  assert.ok(!page.data.options.some((option) => option.id === "google/gemini-3.8-flash"));
  assert.equal(page.data.candidates.find((option) => option.id === "google/gemini-3.8-flash").status, "dismissed");

  await admin("POST", "/api/admin/models/scout/run", {});
  page = await admin("GET", "/api/admin/models");
  assert.equal(page.data.candidates.find((option) => option.id === "google/gemini-3.8-flash").status, "dismissed");

  const relisted = await admin("POST", "/api/admin/models/candidates", { modelId: "google/gemini-3.8-flash", status: "listed" });
  assert.equal(relisted.status, 200);
  page = await admin("GET", "/api/admin/models");
  assert.ok(page.data.options.some((option) => option.id === "google/gemini-3.8-flash" && option.discovered));

  const unknown = await admin("POST", "/api/admin/models/candidates", { modelId: "openai/gpt-6-astra:batch", status: "dismissed" });
  assert.equal(unknown.status, 404);
  const bad = await admin("POST", "/api/admin/models/candidates", { modelId: "openai/gpt-6-astra", status: "hidden" });
  assert.equal(bad.status, 400);
});

test("the admissions-policy scout reports the same two-week cadence", async () => {
  const status = await admin("GET", "/api/admin/policy-scout/status");
  assert.equal(status.status, 200, JSON.stringify(status.data));
  assert.equal(status.data.cadenceDays, 14);
  assert.equal(status.data.nextRunAt, null, "never ran in a fresh database");
  assert.equal(status.data.running, false);
});

test("the model page and the scout run need a counselor session", async () => {
  const anonymous = await fetch(`${baseUrl}/api/admin/models`);
  assert.equal(anonymous.status, 401);
  const noCsrf = await fetch(`${baseUrl}/api/admin/models/scout/run`, { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(noCsrf.status, 401);
});
