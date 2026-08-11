import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readWebSecretConfig, webConfigurationReady } from "./web-secret-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const CONFIG_KEY = String(process.env.WEB_CONFIG_KEY || "");
const SIM_PORT = String(process.env.SIM_PORT || "3002");
const SIM_INTERNAL_TOKEN = String(process.env.SIM_INTERNAL_TOKEN || crypto.randomBytes(32).toString("hex"));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, "..", "frontend", "dist"));

if (CONFIG_KEY.length < 32) {
  console.error("FATAL: WEB_CONFIG_KEY must contain at least 32 characters for website deployment.");
  process.exit(1);
}
if (String(process.env.WEB_ADMIN_BOOTSTRAP_TOKEN || "").length < 24) {
  console.error("FATAL: WEB_ADMIN_BOOTSTRAP_TOKEN must contain at least 24 characters for website deployment.");
  process.exit(1);
}

let backend = null;
let sidecar = null;
let stopping = false;
let restartRequested = false;

function resolvedEnvironment() {
  const stored = readWebSecretConfig({ dataDir: DATA_DIR, configKey: CONFIG_KEY });
  const secrets = {
    encryption: stored.secrets.encryption || String(process.env.ENCRYPTION_KEY || "").trim(),
    openrouter: stored.secrets.openrouter || String(process.env.OPENROUTER_API_KEY || "").trim(),
    scorecard: stored.secrets.scorecard || String(process.env.SCORECARD_API_KEY || "").trim(),
  };
  const ready = webConfigurationReady({ secrets });
  const encryptionConfigured = /^[0-9a-f]{64}$/i.test(secrets.encryption);

  return {
    ...process.env,
    NODE_ENV: "production",
    WEB_DEPLOYMENT: "1",
    WEB_SECRETS_READY: ready ? "1" : "0",
    WEB_ENCRYPTION_CONFIGURED: encryptionConfigured ? "1" : "0",
    HOST: process.env.HOST || "0.0.0.0",
    DATA_DIR,
    PUBLIC_DIR,
    SIM_PORT,
    SIM_INTERNAL_TOKEN,
    SIM_URL: `http://127.0.0.1:${SIM_PORT}`,
    ENCRYPTION_KEY: encryptionConfigured ? secrets.encryption : crypto.randomBytes(32).toString("hex"),
    OPENROUTER_API_KEY: secrets.openrouter,
    SCORECARD_API_KEY: secrets.scorecard,
    OPENROUTER_MODEL_SMALL: stored.models.small || process.env.OPENROUTER_MODEL_SMALL || "",
    OPENROUTER_MODEL_MEDIUM: stored.models.medium || process.env.OPENROUTER_MODEL_MEDIUM || "",
    OPENROUTER_MODEL_LARGE: stored.models.large || process.env.OPENROUTER_MODEL_LARGE || "",
  };
}

function startSidecar() {
  sidecar = spawn(process.execPath, [path.join(__dirname, "simulation-sidecar.js")], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SIM_PORT,
      SIM_INTERNAL_TOKEN,
    },
    stdio: ["inherit", "inherit", "inherit"],
    windowsHide: true,
  });

  sidecar.on("exit", (code, signal) => {
    sidecar = null;
    if (stopping) return;
    console.error(`[WEB] Simulation service stopped unexpectedly (${code ?? signal ?? "unknown"}).`);
    stopping = true;
    backend?.kill("SIGTERM");
    process.exit(code ?? 1);
  });
}

function startBackend() {
  backend = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    cwd: __dirname,
    env: resolvedEnvironment(),
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true,
  });

  backend.on("message", (message) => {
    if (message?.type !== "web-config-updated" || stopping || restartRequested) return;
    restartRequested = true;
    setTimeout(() => backend?.kill("SIGTERM"), 250).unref();
  });

  backend.on("exit", (code, signal) => {
    backend = null;
    if (stopping) return;
    if (restartRequested) {
      restartRequested = false;
      startBackend();
      return;
    }
    stopping = true;
    sidecar?.kill("SIGTERM");
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  backend?.kill(signal);
  sidecar?.kill(signal);
  setTimeout(() => {
    backend?.kill("SIGKILL");
    sidecar?.kill("SIGKILL");
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startSidecar();
startBackend();
