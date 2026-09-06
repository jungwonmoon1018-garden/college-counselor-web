// ═══════════════════════════════════════════════════════════════════════
// OPENROUTER MODEL REFRESH — keep recommended OpenRouter models current, but
// migrate WITH HUMAN APPROVAL (never silently, unlike the Anthropic path).
//
// How it differs from claude-model-migration.js:
//   - Anthropic: retired IDs are rewritten on student rows automatically.
//   - OpenRouter (and other BYOK providers): we only refresh the *recommended*
//     tier defaults from OpenRouter's live model list. The student's stored
//     models are left untouched; the existing "Update models" prompt in the
//     BYOK UI compares stored vs recommended and asks the student to APPROVE
//     before anything changes.
//
// So this module's job is narrow: detect when a recommended default has been
// retired (no longer offered by OpenRouter) and propose an available
// replacement, exposing status for /api/llm/providers and /api/methodology.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { TIER_DEFAULTS } from "./llm-adapters/tier-defaults.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// Mutable recommended defaults (seeded from the static catalog). The providers
// endpoint overlays these for the openrouter provider; ES-module binding means
// importers see live updates.
export const OPENROUTER_TARGETS = {
  small: process.env.OPENROUTER_MODEL_SMALL || TIER_DEFAULTS.openrouter?.small || "google/gemma-4-26b-a4b-it",
  medium: process.env.OPENROUTER_MODEL_MEDIUM || TIER_DEFAULTS.openrouter?.medium || "deepseek/deepseek-v4-flash-0731",
  large: process.env.OPENROUTER_MODEL_LARGE || TIER_DEFAULTS.openrouter?.large || "openai/gpt-5.6-luna",
};
const COUNSELOR_PINNED_TIERS = new Set([
  ["small", process.env.OPENROUTER_MODEL_SMALL],
  ["medium", process.env.OPENROUTER_MODEL_MEDIUM],
  ["large", process.env.OPENROUTER_MODEL_LARGE],
].filter(([, value]) => String(value || "").trim()).map(([tier]) => tier));

// Per-tier preference lists used ONLY to pick a replacement when a current
// default is retired. The refresh picks the first id that is actually live.
// Free/low-cost first so new users aren't surprised by spend.
const TIER_FALLBACKS = {
  small: ["google/gemma-4-26b-a4b-it", "google/gemma-4-31b-it"],
  medium: ["deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-flash"],
  large: ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra", "openai/gpt-5.6-sol"],
};

export const OPENROUTER_STATUS = {
  lastChecked: null,      // ISO string
  availableCount: null,   // number of models OpenRouter returned
  reachable: null,        // boolean
  proposals: [],          // [{ tier, from, to, reason }] — for human approval
  note: "Recommended OpenRouter models are proposed, never auto-applied. Approve changes in your API-key settings.",
};

// Resolve a recommended OpenRouter model id for a tier, GUARANTEEING (when the
// live catalog is loaded) that the returned id is currently served. Callers
// that need a default OpenRouter model should use this rather than reading the
// static TIER_DEFAULTS, so a retired id never leaks through. Order:
//   1. the live-refreshed recommended target, if present in the catalog;
//   2. the first TIER_FALLBACKS[tier] id present in the catalog;
//   3. the static seed/target, when the catalog is empty/unreachable.
export function resolveOpenRouterTier(tier) {
  const seed = OPENROUTER_TARGETS[tier] || TIER_DEFAULTS.openrouter?.[tier] || null;
  const byId = OPENROUTER_CATALOG.byId;
  if (!byId || byId.size === 0) return seed;        // catalog not loaded → trust the seed
  if (seed && byId.has(seed)) return seed;
  const fallback = (TIER_FALLBACKS[tier] || []).find((id) => byId.has(id));
  return fallback || seed;
}

// ─── Live model catalog cache ────────────────────────────────────────────
// Populated from OpenRouter's /api/v1/models. Drives two things:
//   1. GET /api/llm/openrouter/models — the BYOK model dropdown is built from
//      this live list so it only ever shows currently-served model IDs.
//   2. Budget tracking — usage-budget.js prices token usage off the per-model
//      `pricing.prompt` / `pricing.completion` fields here (USD per token).
export const OPENROUTER_CATALOG = {
  models: [],            // [{ id, name, contextLength, pricing:{inputPerMTok, outputPerMTok} }]
  byId: new Map(),       // id → catalog entry
  lastFetched: null,     // ISO string
  reachable: null,       // boolean
};

// Fetch the full model catalog (id, name, context, pricing). pricing.prompt /
// pricing.completion are USD-per-token strings; we expose them as USD per
// 1M tokens for the budget tracker and UI.
export async function fetchOpenRouterModels(fetchImpl = fetch) {
  const res = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`OpenRouter /models ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  return list
    .map((m) => {
      const id = String(m?.id || "").trim();
      if (!id) return null;
      const promptPerTok = Number(m?.pricing?.prompt);
      const completionPerTok = Number(m?.pricing?.completion);
      const created = Number(m?.created);
      return {
        id,
        name: String(m?.name || id),
        contextLength: Number(m?.context_length) || null,
        pricing: {
          inputPerMTok: Number.isFinite(promptPerTok) ? promptPerTok * 1_000_000 : null,
          outputPerMTok: Number.isFinite(completionPerTok) ? completionPerTok * 1_000_000 : null,
        },
        free: /:free$/.test(id) || promptPerTok === 0,
        // Kept for the daily model-catalog scout: when the model appeared and
        // whether it is a text-in / text-out chat model.
        createdAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : null,
        modalities: {
          input: Array.isArray(m?.architecture?.input_modalities) ? m.architecture.input_modalities : [],
          output: Array.isArray(m?.architecture?.output_modalities) ? m.architecture.output_modalities : [],
        },
      };
    })
    .filter(Boolean);
}

// Last-known catalog on disk. The budget tracker refuses every model call
// whose price it cannot verify, and the price table IS this catalog — so a
// failed fetch at boot (one bad response from OpenRouter right after a
// deploy) used to leave the catalog empty and every chat turn answered with
// "The selected model has no verified price" until the daily timer fired.
// Each successful refresh now writes the catalog to a file; a failed
// refresh with nothing in memory loads that file instead.
let catalogCachePath = null;
export function configureOpenRouterCatalogCache(filePath) {
  catalogCachePath = filePath ? String(filePath) : null;
}

function writeCatalogCache(models) {
  if (!catalogCachePath) return;
  try {
    fs.mkdirSync(path.dirname(catalogCachePath), { recursive: true });
    fs.writeFileSync(catalogCachePath, JSON.stringify({ savedAt: nowISO(), models }), "utf8");
  } catch (err) {
    console.warn("[OR-CATALOG] cache write failed:", String(err.message).slice(0, 120));
  }
}

export function loadOpenRouterCatalogCache() {
  if (!catalogCachePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogCachePath, "utf8"));
    return Array.isArray(parsed?.models) && parsed.models.length ? { savedAt: parsed.savedAt || null, models: parsed.models } : null;
  } catch {
    return null;
  }
}

function applyCatalog(models, { reachable, fromCache = null }) {
  OPENROUTER_CATALOG.models = models;
  OPENROUTER_CATALOG.byId = new Map(models.map((m) => [m.id, m]));
  OPENROUTER_CATALOG.reachable = reachable;
  OPENROUTER_CATALOG.lastFetched = nowISO();
  OPENROUTER_CATALOG.fromCache = fromCache;
}

// Refresh the in-memory catalog. Safe to call at boot and on a daily timer.
export async function refreshOpenRouterCatalog({ fetchImpl = fetch } = {}) {
  try {
    const models = await fetchOpenRouterModels(fetchImpl);
    if (!models.length) throw new Error("OpenRouter /models returned no models");
    applyCatalog(models, { reachable: true });
    writeCatalogCache(models);
  } catch (err) {
    OPENROUTER_CATALOG.reachable = false;
    OPENROUTER_CATALOG.lastFetched = nowISO();
    console.warn("[OR-CATALOG] refresh failed:", String(err.message).slice(0, 160));
    if (!OPENROUTER_CATALOG.models.length) {
      const cached = loadOpenRouterCatalogCache();
      if (cached) {
        applyCatalog(cached.models, { reachable: false, fromCache: cached.savedAt || true });
        console.warn(`[OR-CATALOG] serving the last-known catalog from disk (${cached.models.length} models, saved ${cached.savedAt || "unknown"})`);
      }
    }
  }
  return OPENROUTER_CATALOG;
}

// Called on the request path when the catalog is empty: one refresh attempt
// per minute at most, so a chat turn right after a bad boot heals the
// catalog instead of failing on it.
let lastEnsureAttemptAt = 0;
export async function ensureOpenRouterCatalog({ fetchImpl = fetch, minIntervalMs = 60_000 } = {}) {
  if (OPENROUTER_CATALOG.models.length) return OPENROUTER_CATALOG;
  const now = Date.now();
  if (now - lastEnsureAttemptAt < minIntervalMs) return OPENROUTER_CATALOG;
  lastEnsureAttemptAt = now;
  return refreshOpenRouterCatalog({ fetchImpl });
}

// Pricing lookup for the budget tracker. Returns { input, output } USD per
// 1M tokens, or null when the model isn't in the catalog (caller treats
// unknown as $0 — better to undercount than block on a missing price).
export function getOpenRouterPricingUSDPerMTok(modelId) {
  if (!modelId) return null;
  const entry = OPENROUTER_CATALOG.byId.get(String(modelId));
  if (!entry || !entry.pricing) return null;
  const { inputPerMTok, outputPerMTok } = entry.pricing;
  if (inputPerMTok == null && outputPerMTok == null) return null;
  return { input: inputPerMTok || 0, output: outputPerMTok || 0 };
}

// Backwards-compatible helper: the tier-default refresh only needs the set
// of available IDs.
export async function fetchOpenRouterModelIds(fetchImpl = fetch) {
  const models = await fetchOpenRouterModels(fetchImpl);
  return new Set(models.map((m) => m.id));
}

/**
 * Refresh the recommended OpenRouter defaults against the live model list.
 * Retired defaults are replaced with the first available fallback and recorded
 * as a proposal. Returns OPENROUTER_STATUS. Pure-ish: only mutates the two
 * exported objects (intentional, so importers see live values).
 */
export async function refreshOpenRouterTargets({ fetchImpl = fetch, reason = "scheduled" } = {}) {
  OPENROUTER_STATUS.proposals = [];
  let available;
  try {
    available = await fetchOpenRouterModelIds(fetchImpl);
    OPENROUTER_STATUS.reachable = true;
    OPENROUTER_STATUS.availableCount = available.size;
  } catch (err) {
    OPENROUTER_STATUS.reachable = false;
    OPENROUTER_STATUS.availableCount = null;
    OPENROUTER_STATUS.lastChecked = nowISO();
    OPENROUTER_STATUS.error = String(err.message).slice(0, 160);
    return OPENROUTER_STATUS;
  }
  delete OPENROUTER_STATUS.error;

  for (const tier of ["small", "medium", "large"]) {
    const current = OPENROUTER_TARGETS[tier];
    if (current && available.has(current)) continue; // still offered — keep it
    const replacement = (TIER_FALLBACKS[tier] || []).find((id) => available.has(id));
    if (replacement && replacement !== current) {
      OPENROUTER_STATUS.proposals.push({
        tier,
        from: current,
        to: replacement,
        reason: current ? `'${current}' is no longer offered by OpenRouter` : "no default set",
      });
      // A counselor-persisted selection is never silently replaced. The admin
      // page exposes the proposal and live availability so a human can choose.
      if (!COUNSELOR_PINNED_TIERS.has(tier)) OPENROUTER_TARGETS[tier] = replacement;
    }
  }

  OPENROUTER_STATUS.lastChecked = nowISO();
  if (OPENROUTER_STATUS.proposals.length) {
    console.log(`[OR-MIGRATE] ${reason}: ${OPENROUTER_STATUS.proposals.length} recommended OpenRouter model(s) updated (pending user approval).`);
  }
  return OPENROUTER_STATUS;
}

// Isolated so tests can stub it; real boot/daily calls use wall clock.
function nowISO() {
  try { return new Date().toISOString(); } catch { return null; }
}
