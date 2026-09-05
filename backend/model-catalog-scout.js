// ═══════════════════════════════════════════════════════════════════════
// MODEL CATALOG SCOUT — daily search of OpenRouter's catalog for models
// worth adding to the small / medium / large tier lists.
// ═══════════════════════════════════════════════════════════════════════
// The packaged tier list (llm-adapters/tier-defaults.js) is reviewed and
// shipped with the app; it cannot keep up with a catalog that changes
// weekly. Once a day this scout reads the live catalog (already refreshed
// by openrouter-model-refresh.js), keeps the models that are plausible
// counseling workhorses — trusted provider, text in / text out, ≥32k
// context, priced, not a :free / preview / audio / image variant — sorts
// them into a price band, and lists them as additional per-tier options.
// Listed models become selectable by the counselor and accepted by the
// adapter allowlist; the three tier DEFAULTS never change on their own.
// A counselor can dismiss a candidate; dismissed ids stay dismissed.

import crypto from "node:crypto";

export const TRUSTED_PROVIDERS = Object.freeze([
  "openai", "anthropic", "google", "deepseek", "meta-llama", "mistralai", "qwen",
  "x-ai", "z-ai", "moonshotai", "amazon", "cohere", "nvidia", "microsoft",
]);

// Variants and non-chat models: routing suffixes, unstable channels, audio /
// image / embedding / safety models, base checkpoints.
const EXCLUDE_ID_RE = /:free$|:extended$|:online$|:nitro$|:thinking$|(?:^|[/:-])(?:alpha|beta|preview|exp|experimental|nightly|dev|rc\d*)(?:$|[/:-])|-base$|embed|tts|whisper|rerank|moderation|guard|realtime|audio|transcribe|image|dall-?e|imagen|veo|sora|codex|search-preview|distill|vision-only/i;

// Combined USD per 1M tokens (input + output). Above the medium band → large.
export const TIER_PRICE_BANDS = Object.freeze({ small: 1.0, medium: 6.0 });
export const MIN_CONTEXT_LENGTH = 32_000;

export function classifyModelCandidate(model) {
  const id = String(model?.id || "").trim();
  const provider = id.split("/")[0] || "";
  const reasons = [];
  if (!id) reasons.push("no_id");
  if (!TRUSTED_PROVIDERS.includes(provider)) reasons.push("provider_not_trusted");
  if (EXCLUDE_ID_RE.test(id)) reasons.push("variant_or_non_chat");
  const input = Array.isArray(model?.modalities?.input) ? model.modalities.input : [];
  const output = Array.isArray(model?.modalities?.output) ? model.modalities.output : [];
  if (input.length && !input.includes("text")) reasons.push("no_text_input");
  if (output.length && !output.includes("text")) reasons.push("no_text_output");
  if ((Number(model?.contextLength) || 0) < MIN_CONTEXT_LENGTH) reasons.push("context_too_small");
  const inPrice = model?.pricing?.inputPerMTok;
  const outPrice = model?.pricing?.outputPerMTok;
  if (inPrice == null || outPrice == null) reasons.push("no_pricing");
  if (model?.free) reasons.push("free_tier");
  const combined = inPrice != null && outPrice != null ? Math.round((inPrice + outPrice) * 1000) / 1000 : null;
  const tier = combined == null ? null : combined <= TIER_PRICE_BANDS.small ? "small" : combined <= TIER_PRICE_BANDS.medium ? "medium" : "large";
  return { id, provider, tier, combinedPerMTok: combined, eligible: reasons.length === 0, reasons };
}

// ─── Schema ────────────────────────────────────────────────────────────
export function initModelCatalogScout(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_catalog_candidates (
      model_id TEXT PRIMARY KEY,
      provider TEXT,
      name TEXT,
      tier TEXT,
      input_per_mtok REAL,
      output_per_mtok REAL,
      context_length INTEGER,
      created_at TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'listed'
    );
    CREATE TABLE IF NOT EXISTS model_catalog_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      trigger TEXT,
      catalog_count INTEGER DEFAULT 0,
      eligible INTEGER DEFAULT 0,
      added INTEGER DEFAULT 0,
      summary_json TEXT
    );
  `);
}

export function prepareModelCatalogStatements(db) {
  return {
    get: db.prepare("SELECT * FROM model_catalog_candidates WHERE model_id = ?"),
    listAll: db.prepare("SELECT * FROM model_catalog_candidates ORDER BY tier, first_seen DESC, model_id"),
    upsert: db.prepare(`
      INSERT INTO model_catalog_candidates (model_id, provider, name, tier, input_per_mtok, output_per_mtok, context_length, created_at, first_seen, last_seen, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'listed')
      ON CONFLICT(model_id) DO UPDATE SET
        provider = excluded.provider, name = excluded.name, tier = excluded.tier,
        input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok,
        context_length = excluded.context_length, created_at = COALESCE(excluded.created_at, model_catalog_candidates.created_at),
        last_seen = excluded.last_seen`),
    setStatus: db.prepare("UPDATE model_catalog_candidates SET status = ? WHERE model_id = ?"),
    insertRun: db.prepare("INSERT INTO model_catalog_runs (id, started_at, trigger, summary_json) VALUES (?, ?, ?, ?)"),
    finishRun: db.prepare("UPDATE model_catalog_runs SET finished_at = ?, catalog_count = ?, eligible = ?, added = ?, summary_json = ? WHERE id = ?"),
    lastRun: db.prepare("SELECT * FROM model_catalog_runs ORDER BY started_at DESC LIMIT 1"),
  };
}

// ─── The daily run ─────────────────────────────────────────────────────
// `catalog` is OPENROUTER_CATALOG ({ models, byId, reachable }); `knownIds`
// are the packaged option ids, which never become candidates.
export function runModelCatalogScout({ catalog, stmts, knownIds = new Set(), trigger = "scheduled", now = new Date() } = {}) {
  const runId = crypto.randomUUID();
  const startedAt = now.toISOString();
  stmts.insertRun.run(runId, startedAt, trigger, JSON.stringify({ inProgress: true }));
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const added = [];
  const kept = [];
  const rejected = {};
  let eligible = 0;
  for (const model of models) {
    const verdict = classifyModelCandidate(model);
    if (!verdict.eligible) {
      for (const reason of verdict.reasons) rejected[reason] = (rejected[reason] || 0) + 1;
      continue;
    }
    if (knownIds.has(verdict.id)) continue;
    eligible += 1;
    const existing = stmts.get.get(verdict.id);
    stmts.upsert.run(
      verdict.id, verdict.provider, model.name || verdict.id, verdict.tier,
      model.pricing?.inputPerMTok ?? null, model.pricing?.outputPerMTok ?? null,
      model.contextLength ?? null, model.createdAt || null, existing?.first_seen || startedAt, startedAt,
    );
    if (existing) kept.push(verdict.id);
    else added.push({ id: verdict.id, tier: verdict.tier, combinedPerMTok: verdict.combinedPerMTok });
  }
  const summary = {
    runId, trigger, startedAt, finishedAt: new Date().toISOString(),
    catalogCount: models.length, reachable: catalog?.reachable ?? null,
    eligible, added, kept: kept.length, rejected,
  };
  stmts.finishRun.run(summary.finishedAt, models.length, eligible, added.length, JSON.stringify(summary), runId);
  return summary;
}

function rowToOption(row, catalog) {
  const live = catalog?.byId?.get?.(row.model_id) || null;
  return {
    id: row.model_id,
    label: row.name || row.model_id,
    source: `https://openrouter.ai/${row.model_id}`,
    tier: row.tier,
    discovered: true,
    status: row.status,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
    available: live ? true : (catalog?.reachable === true ? false : null),
    contextLength: live?.contextLength ?? row.context_length ?? null,
    pricing: live?.pricing || (row.input_per_mtok != null ? { inputPerMTok: row.input_per_mtok, outputPerMTok: row.output_per_mtok } : null),
  };
}

// Candidates the counselor can pick (listed) — or every candidate when
// `includeDismissed` is set, for the admin review list.
export function listDynamicModelOptions(stmts, { catalog = null, includeDismissed = false } = {}) {
  return stmts.listAll.all()
    .filter((row) => includeDismissed || row.status === "listed")
    .map((row) => rowToOption(row, catalog));
}

export function dynamicAllowedModelIds(stmts) {
  return stmts.listAll.all().filter((row) => row.status === "listed").map((row) => row.model_id);
}

export function setModelCandidateStatus(stmts, modelId, status) {
  if (!["listed", "dismissed"].includes(status)) throw new Error("status must be listed or dismissed");
  const row = stmts.get.get(modelId);
  if (!row) return null;
  stmts.setStatus.run(status, modelId);
  return stmts.get.get(modelId);
}

export function lastModelCatalogRun(stmts) {
  const row = stmts.lastRun.get();
  if (!row) return null;
  let summary = null;
  try { summary = row.summary_json ? JSON.parse(row.summary_json) : null; } catch { summary = null; }
  return {
    id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, trigger: row.trigger,
    catalogCount: row.catalog_count, eligible: row.eligible, added: row.added,
    addedIds: Array.isArray(summary?.added) ? summary.added.map((a) => a.id) : [],
  };
}
