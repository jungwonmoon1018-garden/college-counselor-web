// Rotating WEB_CONFIG_KEY used to make the encrypted configuration
// unreadable for good (every student request 503 until the counselor
// re-entered every secret). With the old key in WEB_CONFIG_KEY_PREVIOUS
// for one deploy the launcher re-wraps the store; without it the store
// stays unreadable but the launcher keeps running and says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openWebSecretConfig, readWebSecretConfig, writeWebSecretConfig } from "../security/web-secret-store.js";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLD_KEY = "old-wrapping-key-with-more-than-thirty-two-characters";
const NEW_KEY = "new-wrapping-key-with-more-than-thirty-two-characters";
const config = { secrets: { encryption: "a".repeat(64), openrouter: `sk-or-v1-${"b".repeat(40)}`, scorecard: "c".repeat(30) }, models: { small: "x/y" } };

test("a rotated key opens the store with the previous key and writes it again under the new one", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-rotate-"));
  try {
    writeWebSecretConfig({ dataDir, configKey: OLD_KEY, config });
    const opened = openWebSecretConfig({ dataDir, configKey: NEW_KEY, previousKey: OLD_KEY });
    assert.equal(opened.opened, "rewrapped");
    assert.deepEqual(opened.config.secrets, config.secrets);
    assert.deepEqual(readWebSecretConfig({ dataDir, configKey: NEW_KEY }).secrets, config.secrets, "the new key reads it now");
    assert.throws(() => readWebSecretConfig({ dataDir, configKey: OLD_KEY }), (err) => err.code === "web_config_unreadable", "the old key no longer does");
    const again = openWebSecretConfig({ dataDir, configKey: NEW_KEY, previousKey: OLD_KEY });
    assert.equal(again.opened, "current", "a second boot with the previous key still set does nothing");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("without the previous key the store stays unreadable, and a wrong previous key is refused", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-rotate-"));
  try {
    writeWebSecretConfig({ dataDir, configKey: OLD_KEY, config });
    assert.throws(() => openWebSecretConfig({ dataDir, configKey: NEW_KEY }), (err) => err.code === "web_config_unreadable");
    assert.throws(() => openWebSecretConfig({ dataDir, configKey: NEW_KEY, previousKey: "another-wrong-key-that-is-long-enough-too" }), (err) => err.code === "web_config_unreadable");
    assert.deepEqual(readWebSecretConfig({ dataDir, configKey: OLD_KEY }).secrets, config.secrets, "nothing was rewritten");
    const fresh = openWebSecretConfig({ dataDir: path.join(dataDir, "empty"), configKey: NEW_KEY, previousKey: OLD_KEY });
    assert.equal(fresh.opened, "current", "no store at all is an empty configuration, not a rotation");
    assert.deepEqual(fresh.config.secrets, {});
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the launcher passes the previous key, survives an unreadable store, and strips the switches from the server's environment", () => {
  const launcher = fs.readFileSync(path.join(BACKEND, "web-launcher.mjs"), "utf8");
  assert.ok(launcher.includes("openWebSecretConfig({ dataDir: DATA_DIR, configKey: CONFIG_KEY, previousKey: PREVIOUS_CONFIG_KEY })"));
  assert.ok(launcher.includes('if (error.code !== "web_config_unreadable" && error.code !== "invalid_web_config_key") throw error;'));
  assert.ok(launcher.includes("WEB_CONFIG_UNREADABLE: configUnreadable,"));
  assert.ok(launcher.includes("delete env.RATE_LIMIT_RELAXED;"));
  assert.ok(launcher.includes("delete env.WEB_CONFIG_KEY_PREVIOUS;"));
  const server = fs.readFileSync(path.join(BACKEND, "server.js"), "utf8");
  assert.ok(server.includes('const RATE_LIMIT_RELAXED = process.env.RATE_LIMIT_RELAXED === "1" && NODE_ENV === "test";'), "the switch works under the test runner only");
  const admin = fs.readFileSync(path.join(BACKEND, "routes", "admin.js"), "utf8");
  assert.ok(admin.includes("configReadable: !deps.WEB_CONFIG_UNREADABLE"), "the administrator page is told");
});
