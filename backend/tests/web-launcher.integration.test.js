import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, output) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Website launcher did not become ready.\n${output.join("")}`);
}

test("website launcher gates students and protects first counselor bootstrap", { timeout: 30_000 }, async () => {
  const [port, simPort] = await Promise.all([freePort(), freePort()]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-web-launcher-"));
  const output = [];
  const child = spawn(process.execPath, ["web-launcher.mjs"], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      SIM_PORT: String(simPort),
      DATA_DIR: dataDir,
      PUBLIC_DIR: path.join(backendDir, "..", "frontend", "dist"),
      WEB_CONFIG_KEY: "integration-wrapping-key-with-more-than-thirty-two-characters",
      WEB_ADMIN_BOOTSTRAP_TOKEN: "integration-bootstrap-token-long-enough",
      WEB_COOKIE_SECURE: "0",
      CDS_DAILY_REFRESH: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  const originHeaders = { Origin: base, "Content-Type": "application/json" };
  try {
    await waitFor(`${base}/api/health`, output);

    const status = await fetch(`${base}/api/admin/status`).then((response) => response.json());
    assert.equal(status.webDeployment, true);
    assert.equal(status.installationReady, false);

    const student = await fetch(`${base}/api/students/register`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(student.status, 503);
    assert.equal((await student.json()).code, "installation_setup_required");

    const denied = await fetch(`${base}/api/admin/bootstrap`, {
      method: "POST",
      headers: originHeaders,
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    assert.equal(denied.status, 403);

    const created = await fetch(`${base}/api/admin/bootstrap`, {
      method: "POST",
      headers: { ...originHeaders, "X-Web-Setup-Token": "integration-bootstrap-token-long-enough" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    assert.equal(created.status, 201, output.join(""));
    assert.match(created.headers.get("set-cookie") || "", /cc_admin_session=/);
    assert.ok((await created.json()).recoveryCode);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
});
