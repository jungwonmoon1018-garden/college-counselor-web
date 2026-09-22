import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openWebSecretConfig, webConfigurationReady } from "./security/web-secret-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const CONFIG_KEY = String(process.env.WEB_CONFIG_KEY || "");
// The key that wrote the store before a rotation, for one deploy
// (RUNBOOK.md, *Runtime*): the store is re-wrapped under CONFIG_KEY.
const PREVIOUS_CONFIG_KEY = String(process.env.WEB_CONFIG_KEY_PREVIOUS || "");
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

// The hosted instance has 512 MB for this launcher and its two children,
// and V8 sizes each heap from the memory it sees, collecting lazily below
// that size. Measured on 2026-09-21: ten Common Data Sets parsed in a row
// left 263 MB of heap (414 MB resident) although 17 MB of it was live; with
// the old space capped at 160 MB the heap stayed at 148 MB, and with 8 MB
// semi-spaces as well at 44 MB (163 MB resident). Each child therefore gets
// an explicit budget: the server's live heap peaked near 110 MB with three
// attachment turns in flight. NODE_FLAGS_SERVER and NODE_FLAGS_SIDECAR
// replace the defaults (an empty value removes them).
function nodeFlags(envName, fallback) {
  const raw = process.env[envName];
  return String(raw == null ? fallback : raw).split(" ").filter(Boolean);
}
const SERVER_NODE_FLAGS = nodeFlags("NODE_FLAGS_SERVER", "--max-old-space-size=192 --max-semi-space-size=8");
const SIDECAR_NODE_FLAGS = nodeFlags("NODE_FLAGS_SIDECAR", "--max-old-space-size=96 --max-semi-space-size=4");

let backend = null;
let sidecar = null;
let stopping = false;
let restartRequested = false;

function resolvedEnvironment() {
  let stored;
  let configUnreadable = "";
  try {
    const opened = openWebSecretConfig({ dataDir: DATA_DIR, configKey: CONFIG_KEY, previousKey: PREVIOUS_CONFIG_KEY });
    stored = opened.config;
    if (opened.opened === "rewrapped") console.log("[WEB] The encrypted configuration was opened with WEB_CONFIG_KEY_PREVIOUS and written again under WEB_CONFIG_KEY; remove WEB_CONFIG_KEY_PREVIOUS now.");
  } catch (error) {
    // A store written under another key. The site says setup is required,
    // the administrator page says why, and saving a secret starts the
    // store again; this used to end the launcher (a crash loop of 502s).
    if (error.code !== "web_config_unreadable" && error.code !== "invalid_web_config_key") throw error;
    configUnreadable = error.code;
    stored = { secrets: {}, models: {} };
    console.error(`[WEB] The encrypted configuration on the disk cannot be opened with the current WEB_CONFIG_KEY (${error.code}). Restore the key that wrote it, or set WEB_CONFIG_KEY_PREVIOUS to that key for one deploy so the store is re-wrapped, or re-enter every secret on the administrator page.`);
  }
  const secrets = {
    encryption: stored.secrets.encryption || String(process.env.ENCRYPTION_KEY || "").trim(),
    openrouter: stored.secrets.openrouter || String(process.env.OPENROUTER_API_KEY || "").trim(),
    scorecard: stored.secrets.scorecard || String(process.env.SCORECARD_API_KEY || "").trim(),
  };
  const ready = webConfigurationReady({ secrets });
  const encryptionConfigured = /^[0-9a-f]{64}$/i.test(secrets.encryption);

  const env = {
    ...process.env,
    NODE_ENV: "production",
    WEB_DEPLOYMENT: "1",
    WEB_SECRETS_READY: ready ? "1" : "0",
    WEB_ENCRYPTION_CONFIGURED: encryptionConfigured ? "1" : "0",
    WEB_CONFIG_UNREADABLE: configUnreadable,
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
  // Test-runner switches and the previous key never reach the server.
  delete env.RATE_LIMIT_RELAXED;
  delete env.WEB_CONFIG_KEY_PREVIOUS;
  return env;
}

function startSidecar() {
  sidecar = spawn(process.execPath, [...SIDECAR_NODE_FLAGS, path.join(__dirname, "simulation-sidecar.js")], {
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
  backend = spawn(process.execPath, [...SERVER_NODE_FLAGS, path.join(__dirname, "server.js")], {
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
