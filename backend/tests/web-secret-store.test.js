import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  mergeWebModels,
  mergeWebSecret,
  readWebSecretConfig,
  webConfigurationReady,
  webSecretConfigPath,
  writeWebSecretConfig,
} from "../web-secret-store.js";

const CONFIG_KEY = "test-wrapping-key-that-is-longer-than-thirty-two-characters";

test("web secret configuration is encrypted at rest and round-trips", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-web-secrets-"));
  const config = {
    secrets: {
      encryption: "a".repeat(64),
      openrouter: `sk-or-v1-${"b".repeat(24)}`,
      scorecard: "c".repeat(24),
    },
    models: { small: "deepseek/deepseek-v4-flash" },
  };

  writeWebSecretConfig({ dataDir, configKey: CONFIG_KEY, config });
  const raw = fs.readFileSync(webSecretConfigPath(dataDir), "utf8");
  assert.doesNotMatch(raw, /sk-or-v1/);
  assert.doesNotMatch(raw, /deepseek-v4-flash/);
  assert.deepEqual(readWebSecretConfig({ dataDir, configKey: CONFIG_KEY }).secrets, config.secrets);
  assert.equal(webConfigurationReady(config), true);

  writeWebSecretConfig({ dataDir, configKey: CONFIG_KEY, config: mergeWebSecret(config, "scorecard", "d".repeat(24)) });
  assert.equal(readWebSecretConfig({ dataDir, configKey: CONFIG_KEY }).secrets.scorecard, "d".repeat(24));
  assert.equal(webConfigurationReady({ secrets: { encryption: "a".repeat(64) } }), false);
});

test("web secret and model merges preserve unrelated values", () => {
  const base = { secrets: { encryption: "a".repeat(64) }, models: { small: "one" } };
  const withKey = mergeWebSecret(base, "openrouter", `sk-or-v1-${"x".repeat(24)}`);
  const withModels = mergeWebModels(withKey, { medium: "two", large: "three" });
  assert.equal(withModels.secrets.encryption, "a".repeat(64));
  assert.deepEqual(withModels.models, { small: "one", medium: "two", large: "three" });
});

test("a different wrapping key cannot decrypt the configuration", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-web-secrets-bad-key-"));
  writeWebSecretConfig({ dataDir, configKey: CONFIG_KEY, config: { secrets: { encryption: "a".repeat(64) } } });
  assert.throws(
    () => readWebSecretConfig({ dataDir, configKey: "different-wrapping-key-that-is-also-long-enough" }),
    { code: "web_config_unreadable" },
  );
});
