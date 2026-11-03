// A tier whose configured model cannot be called, against a running server
// in website mode: the model page says so per tier, the boot log says so,
// a save that changes only another tier goes through, and the model a tier
// uses cannot be dismissed. Before this, a model the scout pruned left the
// tier failing for every student with nothing on the admin page, and every
// later save was refused until that tier was changed too.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refusedModelTier } from "../routes/admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FETCH_MOCK = path.join(__dirname, "helpers", "mock-openrouter-fetch.mjs");

// small: a model the scout discovers (allowed once it has run).
// medium: in OpenRouter's catalog but never allowed (a routing variant).
// large: not in OpenRouter's catalog at all.
const SMALL = "qwen/qwen3.8-flash";
const MEDIUM = "openai/gpt-6-astra:batch";
const LARGE = "google/retired-model-2025";

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

// Up to a minute (see council-naming-deadlines-routes.test.js).
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
  for (let attempt = 0; attempt < 100; attempt++) {
    page = await admin("GET", "/api/admin/models");
    if (page.status === 200 && page.data?.catalogScout?.lastRun?.finishedAt) return page;
    await delay(100);
  }
  return page;
}

before(async () => {
  const port = await freePort();
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "college-counselor-model-tiers-"));
  baseUrl = `http://127.0.0.1:${port}`;

  serverProcess = spawn(process.execPath, ["--import", pathToFileURL(FETCH_MOCK).href, "server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
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
      // Website mode, so the model save route is reachable.
      WEB_DEPLOYMENT: "1",
      WEB_SECRETS_READY: "1",
      WEB_CONFIG_KEY: "cd".repeat(32),
      WEB_ADMIN_BOOTSTRAP_TOKEN: "",
      OPENROUTER_MODEL_SMALL: SMALL,
      OPENROUTER_MODEL_MEDIUM: MEDIUM,
      OPENROUTER_MODEL_LARGE: LARGE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  serverProcess.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  await waitForHealth();

  const boot = await fetch(`${baseUrl}/api/admin/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "correct horse battery staple" }),
  });
  const bootBody = await boot.json();
  assert.equal(boot.status, 201, JSON.stringify(bootBody));
  adminCookie = String(boot.headers.get("set-cookie") || "").split(";")[0];
  csrfToken = bootBody.csrfToken;
  assert.ok(adminCookie && csrfToken);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode == null) {
    serverProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => serverProcess.once("exit", resolve)),
      delay(5000),
    ]);
    if (serverProcess.exitCode == null) serverProcess.kill("SIGKILL"); // a server that will not exit must not hang the runner
  }
  if (testDataDir) fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("the model page reports each tier's status, and the boot log names the broken tiers", async () => {
  const page = await modelPage();
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.deepEqual(page.data.models, { small: SMALL, medium: MEDIUM, large: LARGE });
  assert.deepEqual(page.data.tierStatus, {
    small: { model: SMALL, status: "ok" },
    medium: { model: MEDIUM, status: "not_in_allowlist" },
    large: { model: LARGE, status: "not_in_catalog" },
  });
  for (let attempt = 0; attempt < 50 && !/\[MODEL-TIERS\] boot: the large tier/.test(serverOutput); attempt++) await delay(100);
  assert.match(serverOutput, /\[MODEL-TIERS\] boot: the medium tier is set to openai\/gpt-6-astra:batch, which is not on the model allowlist \(not_in_allowlist\)/);
  assert.match(serverOutput, /\[MODEL-TIERS\] boot: the large tier is set to google\/retired-model-2025, which is no longer listed in OpenRouter's catalog \(not_in_catalog\)/);
  assert.doesNotMatch(serverOutput, /\[MODEL-TIERS\] boot: the small tier/);
  // A manual check returns the same per-tier status beside its summary.
  const run = await admin("POST", "/api/admin/models/scout/run", {});
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.summary.trigger, "manual");
  assert.equal(run.data.tierStatus.large.status, "not_in_catalog");
});

test("a save that changes only a working tier goes through while the broken tiers are left as they are", async () => {
  await modelPage();
  const changeSmall = await admin("PUT", "/api/admin/models", { models: { small: "google/gemma-4-31b-it", medium: MEDIUM, large: LARGE } });
  assert.equal(changeSmall.status, 202, JSON.stringify(changeSmall.data));
  // A tier not sent keeps its model.
  const onlySmall = await admin("PUT", "/api/admin/models", { models: { small: "google/gemma-4-26b-a4b-it" } });
  assert.equal(onlySmall.status, 202, JSON.stringify(onlySmall.data));

  // The other direction: a tier that changes is still checked.
  const badMedium = await admin("PUT", "/api/admin/models", { models: { small: SMALL, medium: "openai/gpt-6-astra-unlisted", large: LARGE } });
  assert.equal(badMedium.status, 400);
  assert.equal(badMedium.data.tier, "medium");
  const cleared = await admin("PUT", "/api/admin/models", { models: { small: "" } });
  assert.equal(cleared.status, 400);
  assert.equal(cleared.data.tier, "small");
  const nothing = await admin("PUT", "/api/admin/models", { models: {} });
  assert.equal(nothing.status, 400);
});

test("the model a tier uses cannot be dismissed; another found model can", async () => {
  await modelPage();
  const inUse = await admin("POST", "/api/admin/models/candidates", { modelId: SMALL, status: "dismissed" });
  assert.equal(inUse.status, 409, JSON.stringify(inUse.data));
  assert.equal(inUse.data.code, "model_in_use");
  assert.deepEqual(inUse.data.tiers, ["small"]);
  const other = await admin("POST", "/api/admin/models/candidates", { modelId: "google/gemini-3.8-flash", status: "dismissed" });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  const relisted = await admin("POST", "/api/admin/models/candidates", { modelId: "google/gemini-3.8-flash", status: "listed" });
  assert.equal(relisted.status, 200);
});

test("only a tier whose value changes is checked against the allowed models", () => {
  const current = { small: "a/one", medium: "b/retired", large: "c/three" };
  const allowed = new Set(["a/one", "a/two", "c/three"]);
  assert.equal(refusedModelTier({ small: "a/two", medium: "b/retired", large: "c/three" }, { current, allowed }), null);
  assert.equal(refusedModelTier({ large: "c/three" }, { current, allowed }), null);
  assert.equal(refusedModelTier({ medium: "b/other" }, { current, allowed }), "medium");
  assert.equal(refusedModelTier({ small: " " }, { current, allowed }), "small");
  assert.equal(refusedModelTier({}, { current, allowed }), "small");
  assert.equal(refusedModelTier(null, { current, allowed }), "small");
});
