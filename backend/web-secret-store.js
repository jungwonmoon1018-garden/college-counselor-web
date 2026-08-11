import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONFIG_FILENAME = "web-secrets.enc.json";
const AAD = Buffer.from("college-counselor:web-secrets:v1", "utf8");
const ALLOWED_SECRET_NAMES = new Set(["encryption", "openrouter", "scorecard"]);
const ALLOWED_MODEL_TIERS = new Set(["small", "medium", "large"]);

function wrappingKey(value) {
  const normalized = String(value || "");
  if (normalized.length < 32) {
    const error = new Error("WEB_CONFIG_KEY must contain at least 32 characters.");
    error.code = "invalid_web_config_key";
    throw error;
  }
  return crypto.createHash("sha256").update(normalized, "utf8").digest();
}

function normalizeConfig(config = {}) {
  const secrets = {};
  for (const name of ALLOWED_SECRET_NAMES) {
    const value = String(config?.secrets?.[name] || "").trim();
    if (value) secrets[name] = value;
  }

  const models = {};
  for (const tier of ALLOWED_MODEL_TIERS) {
    const value = String(config?.models?.[tier] || "").trim();
    if (value) models[tier] = value;
  }

  return {
    version: 1,
    secrets,
    models,
    updatedAt: typeof config.updatedAt === "string" ? config.updatedAt : new Date().toISOString(),
  };
}

export function webSecretConfigPath(dataDir) {
  return path.join(path.resolve(dataDir), CONFIG_FILENAME);
}

export function readWebSecretConfig({ dataDir, configKey }) {
  const filename = webSecretConfigPath(dataDir);
  if (!fs.existsSync(filename)) return normalizeConfig({});

  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (envelope?.version !== 1) throw new Error("unsupported version");
    const iv = Buffer.from(String(envelope.iv || ""), "base64");
    const tag = Buffer.from(String(envelope.tag || ""), "base64");
    const ciphertext = Buffer.from(String(envelope.ciphertext || ""), "base64");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("invalid envelope");

    const decipher = crypto.createDecipheriv("aes-256-gcm", wrappingKey(configKey), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return normalizeConfig(JSON.parse(plaintext.toString("utf8")));
  } catch (cause) {
    const error = new Error("The encrypted web configuration could not be opened.");
    error.code = "web_config_unreadable";
    error.cause = cause;
    throw error;
  }
}

export function writeWebSecretConfig({ dataDir, configKey, config }) {
  const directory = path.resolve(dataDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const normalized = normalizeConfig({ ...config, updatedAt: new Date().toISOString() });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", wrappingKey(configKey), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(normalized), "utf8"),
    cipher.final(),
  ]);
  const envelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };

  const filename = webSecretConfigPath(directory);
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
  try { fs.chmodSync(filename, 0o600); } catch {}
  return normalized;
}

export function webConfigurationReady(config) {
  const secrets = normalizeConfig(config).secrets;
  return /^[0-9a-f]{64}$/i.test(secrets.encryption || "")
    && /^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(secrets.openrouter || "")
    && (secrets.scorecard === "DEMO_KEY" || /^[A-Za-z0-9]{20,64}$/.test(secrets.scorecard || ""));
}

export function mergeWebSecret(config, name, value) {
  if (!ALLOWED_SECRET_NAMES.has(name)) {
    const error = new Error("Unknown web secret.");
    error.code = "unknown_web_secret";
    throw error;
  }
  const current = normalizeConfig(config);
  const nextSecrets = { ...current.secrets };
  const normalized = String(value || "").trim();
  if (normalized) nextSecrets[name] = normalized;
  else delete nextSecrets[name];
  return normalizeConfig({ ...current, secrets: nextSecrets });
}

export function mergeWebModels(config, models) {
  const current = normalizeConfig(config);
  const nextModels = { ...current.models };
  for (const tier of ALLOWED_MODEL_TIERS) {
    if (models?.[tier] != null) nextModels[tier] = String(models[tier]).trim();
  }
  return normalizeConfig({ ...current, models: nextModels });
}
