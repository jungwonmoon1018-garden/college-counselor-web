// ═══════════════════════════════════════════════════════════════════════
// MODEL CATALOG SCOUT — periodic search of OpenRouter's catalog for models
// worth adding to the small / medium / large tier lists.
// ═══════════════════════════════════════════════════════════════════════
// The packaged tier list (llm-adapters/tier-defaults.js) is reviewed and
// shipped with the app; it cannot keep up with a catalog that changes
// weekly. On its cadence (every two weeks — scout-cadence.js) this scout
// reads the live catalog (already refreshed
// by openrouter-model-refresh.js), keeps the models that are plausible
// counseling workhorses — trusted provider, text in / text out, ≥32k
// context, priced, not a :free / preview / audio / image variant — sorts
// them into a price band, and lists them as additional per-tier options.
// Listed models become selectable by the counselor and accepted by the
// adapter allowlist; the three tier DEFAULTS never change on their own.
// A counselor can dismiss a candidate; dismissed ids stay dismissed. Rows a
// run does not confirm (gone from the catalog, or no longer eligible after
// a rule change) are removed so the picker only ever shows current models —
// except a model a tier is set to, which stays listed (and allowed) while
// it is in use: see runModelCatalogScout.

import crypto from "node:crypto";
import { failedStreak } from "./scout-cadence.js";

export const TRUSTED_PROVIDERS = Object.freeze([
  "openai", "anthropic", "google", "deepseek", "meta-llama", "mistralai", "qwen",
  "x-ai", "z-ai", "moonshotai", "amazon", "cohere", "nvidia", "microsoft",
]);

// Variants and non-chat models: any ":suffix" routing variant (:free, :batch,
// :extended, :thinking, …), unstable channels, audio / image / embedding /
// safety models, base checkpoints.
const EXCLUDE_ID_RE = /:[a-z0-9-]+$|(?:^|[/:-])(?:alpha|beta|preview|exp|experimental|nightly|dev|rc\d*)(?:$|[/:-])|-base$|embed|tts|whisper|rerank|moderation|guard|safety|realtime|audio|transcribe|image|dall-?e|imagen|veo|sora|codex|search-preview|distill|vision-only/i;

// Combined USD per 1M tokens (input + output). Above the medium band → large.
export const TIER_PRICE_BANDS = Object.freeze({ small: 1.0, medium: 6.0 });
// Bumped whenever the eligibility rules change. A boot after a bump runs the
// scout at once — regardless of the cadence — so rows an older rule set let
// in are pruned rather than sitting in the picker for another two weeks.
//   1: first rules   2: no ":suffix" variants / safety models, one-year age
//   cap, unseen rows pruned   3: a model a tier is set to is exempt from the
//   age cap and is never pruned while it is in use
export const MODEL_SCOUT_VERSION = 3;
export const MIN_CONTEXT_LENGTH = 32_000;
// A "new model to add" is one that appeared within the last year; the long
// tail of older catalog rows would only bury the picker.
export const MAX_MODEL_AGE_DAYS = 365;
export const DEFAULT_PER_TIER_LIMIT = 15;

export function classifyModelCandidate(model, now = new Date()) {
  const id = String(model?.id || "").trim();
  const provider = id.split("/")[0] || "";
  const reasons = [];
  if (!id) reasons.push("no_id");
  if (!TRUSTED_PROVIDERS.includes(provider)) reasons.push("provider_not_trusted");
  if (EXCLUDE_ID_RE.test(id)) reasons.push("variant_or_non_chat");
  const createdMs = Date.parse(model?.createdAt || "");
  if (!Number.isFinite(createdMs)) reasons.push("no_creation_date");
  else if (now.getTime() - createdMs > MAX_MODEL_AGE_DAYS * 24 * 60 * 60 * 1000) reasons.push("older_than_a_year");
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
  // A run row without a finish time at boot belongs to a process that is
  // gone, so it is abandoned, not in progress; the cadence check then runs
  // the scout at once instead of waiting out the age threshold.
  try {
    db.prepare(`
      UPDATE model_catalog_runs
      SET summary_json = json_set(COALESCE(summary_json, '{}'), '$.inProgress', json('false'), '$.abandoned', json('true'))
      WHERE finished_at IS NULL
    `).run();
  } catch { /* JSON1 unavailable — the age threshold still applies */ }
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
    listUnseen: db.prepare("SELECT model_id FROM model_catalog_candidates WHERE last_seen < ? AND status != 'dismissed'"),
    deleteCandidate: db.prepare("DELETE FROM model_catalog_candidates WHERE model_id = ?"),
    insertRun: db.prepare("INSERT INTO model_catalog_runs (id, started_at, trigger, summary_json) VALUES (?, ?, ?, ?)"),
    finishRun: db.prepare("UPDATE model_catalog_runs SET finished_at = ?, catalog_count = ?, eligible = ?, added = ?, summary_json = ? WHERE id = ?"),
    lastRun: db.prepare("SELECT * FROM model_catalog_runs ORDER BY started_at DESC LIMIT 1"),
    listRuns: db.prepare("SELECT * FROM model_catalog_runs ORDER BY started_at DESC LIMIT ?"),
  };
}

// ─── The scout run ─────────────────────────────────────────────────────
// `catalog` is OPENROUTER_CATALOG ({ models, byId, reachable }); `knownIds`
// are the packaged option ids, which never become candidates; `inUseIds`
// are the models the three tiers are set to (OPENROUTER_TARGETS).
//
// A model a tier is set to is exempt from the one-year age cap and is never
// pruned while a tier uses it. The cap and the prune came in with rule
// version 2 without that exemption: a model the counselor picked when it
// was new turned one year old while OpenRouter still served it, the next
// run deleted its row, the adapter allowlist dropped it, and every call on
// that tier failed with model_not_allowed for every student — triggered by
// nothing but the calendar. An in-use row the rules alone would remove is
// kept and reported in `inUseKept`, so the counselor's page can say why.
export function runModelCatalogScout({ catalog, stmts, knownIds = new Set(), inUseIds = [], trigger = "scheduled", now = new Date() } = {}) {
  const runId = crypto.randomUUID();
  const startedAt = now.toISOString();
  stmts.insertRun.run(runId, startedAt, trigger, JSON.stringify({ inProgress: true, scoutVersion: MODEL_SCOUT_VERSION }));
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const inUse = new Set([...(inUseIds || [])].map((id) => String(id || "").trim()).filter(Boolean));
  const added = [];
  const kept = [];
  const inUseKept = [];
  const seen = new Set();
  const rejected = {};
  let eligible = 0;
  for (const model of models) {
    const verdict = classifyModelCandidate(model, now);
    seen.add(verdict.id);
    const exempt = inUse.has(verdict.id);
    const reasons = exempt ? verdict.reasons.filter((reason) => reason !== "older_than_a_year") : verdict.reasons;
    if (reasons.length) {
      for (const reason of verdict.reasons) rejected[reason] = (rejected[reason] || 0) + 1;
      if (exempt && stmts.get.get(verdict.id)) inUseKept.push({ id: verdict.id, reasons: verdict.reasons });
      continue;
    }
    if (knownIds.has(verdict.id)) continue;
    eligible += 1;
    if (exempt && reasons.length !== verdict.reasons.length) inUseKept.push({ id: verdict.id, reasons: verdict.reasons });
    const existing = stmts.get.get(verdict.id);
    stmts.upsert.run(
      verdict.id, verdict.provider, model.name || verdict.id, verdict.tier,
      model.pricing?.inputPerMTok ?? null, model.pricing?.outputPerMTok ?? null,
      model.contextLength ?? null, model.createdAt || null, existing?.first_seen || startedAt, startedAt,
    );
    if (existing) kept.push(verdict.id);
    else added.push({ id: verdict.id, tier: verdict.tier, combinedPerMTok: verdict.combinedPerMTok });
  }
  // Rows this run did not confirm leave the picker — a model that fell out
  // of the catalog, or one that an earlier, looser rule set let in (":batch"
  // variants, safety models). Dismissals are kept so a returning model stays
  // dismissed. An empty catalog (OpenRouter unreachable) prunes nothing. A
  // row a tier uses is never pruned: if OpenRouter stopped listing it, it is
  // reported (the tier status says not_in_catalog) and the counselor
  // chooses; calls resume on their own if the catalog lists it again.
  let pruned = 0;
  if (models.length) {
    for (const { model_id: id } of stmts.listUnseen.all(startedAt)) {
      if (inUse.has(id)) {
        if (!seen.has(id)) inUseKept.push({ id, reasons: ["not_in_catalog"] });
        continue;
      }
      pruned += stmts.deleteCandidate.run(id).changes;
    }
  }
  // A check with no live catalog to read did not do its work: the cadence
  // retries it within the hour (scout-cadence.js) instead of a fortnight
  // later. A last-known catalog from the disk still feeds the picker, but
  // only OpenRouter's live list shows what is new.
  const outcome = models.length === 0 || catalog?.reachable === false ? "failed" : "completed";
  const summary = {
    runId, trigger, startedAt, finishedAt: new Date().toISOString(), scoutVersion: MODEL_SCOUT_VERSION,
    outcome, catalogCount: models.length, reachable: catalog?.reachable ?? null,
    eligible, added, kept: kept.length, pruned, rejected, inUseKept,
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

// Candidates the counselor can pick: the newest `perTierLimit` listed models
// per tier — or every candidate when `includeDismissed` is set, for the
// admin review list.
export function listDynamicModelOptions(stmts, { catalog = null, includeDismissed = false, perTierLimit = DEFAULT_PER_TIER_LIMIT } = {}) {
  const rows = stmts.listAll.all().filter((row) => includeDismissed || row.status === "listed");
  if (includeDismissed || !perTierLimit) return rows.map((row) => rowToOption(row, catalog));
  const byTier = new Map();
  for (const row of rows) {
    if (!byTier.has(row.tier)) byTier.set(row.tier, []);
    byTier.get(row.tier).push(row);
  }
  const out = [];
  for (const tier of ["small", "medium", "large"]) {
    const list = (byTier.get(tier) || []).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    out.push(...list.slice(0, perTierLimit).map((row) => rowToOption(row, catalog)));
  }
  return out;
}

// Every listed candidate is allowed for use (a counselor may have picked one
// that later fell out of the newest-N picker window).
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

function runSummary(row) {
  try { return row.summary_json ? JSON.parse(row.summary_json) : null; } catch { return null; }
}

function runOutcome(row, summary) {
  if (summary?.abandoned === true) return "abandoned";
  if (!row.finished_at) return "in_progress";
  return summary?.outcome === "failed" ? "failed" : "completed";
}

// The newest run, with how many runs in a row have failed (the cadence's
// retry backoff counts them).
export function lastModelCatalogRun(stmts) {
  const rows = stmts.listRuns.all(25);
  const row = rows[0];
  if (!row) return null;
  const summary = runSummary(row);
  return {
    id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, trigger: row.trigger,
    outcome: runOutcome(row, summary),
    failedStreak: failedStreak(rows.map((r) => runOutcome(r, runSummary(r)))),
    scoutVersion: summary?.scoutVersion ?? 1,
    abandoned: summary?.abandoned === true,
    reachable: summary?.reachable ?? null,
    catalogCount: row.catalog_count, eligible: row.eligible, added: row.added, pruned: summary?.pruned ?? 0,
    addedIds: Array.isArray(summary?.added) ? summary.added.map((a) => a.id) : [],
    inUseKept: Array.isArray(summary?.inUseKept) ? summary.inUseKept : [],
  };
}

// ─── Tier status ───────────────────────────────────────────────────────
// Whether each tier's configured model can be called right now, in the
// order the call path would refuse it: OpenRouter no longer lists it, the
// adapter allowlist refuses it (model_not_allowed), or the budget has no
// verified price for it (unknown_model_pricing). The admin page shows a
// banner for any tier that is not "ok" and the server logs one at boot;
// nothing switches the tier to another model on its own, because a
// counselor's selection is never silently replaced. A status is one of
// "ok", "not_in_catalog", "not_in_allowlist", "no_price".
export function modelTierStatus({ targets = {}, catalog = null, isAllowed = () => true, pricingLookup = () => null } = {}) {
  const byId = catalog?.byId instanceof Map ? catalog.byId : new Map();
  const out = {};
  for (const tier of ["small", "medium", "large"]) {
    const model = String(targets?.[tier] || "").trim() || null;
    let status = "ok";
    if (!model) status = "not_in_allowlist";
    else if (byId.size > 0 && !byId.has(model)) status = "not_in_catalog";
    else if (!isAllowed(model)) status = "not_in_allowlist";
    else if (!pricingLookup(model)) status = "no_price";
    out[tier] = { model, status };
  }
  return out;
}

export function tierStatusProblems(status) {
  return Object.entries(status || {})
    .filter(([, entry]) => entry?.status && entry.status !== "ok")
    .map(([tier, entry]) => ({ tier, model: entry.model, status: entry.status }));
}
