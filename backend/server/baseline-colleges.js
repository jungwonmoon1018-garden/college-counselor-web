// server/baseline-colleges.js — the baseline college rows: lookup by name or
// unit id, the search response, and the Scorecard query cache. Moved out of server.js on 2026-09-20.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (BASELINE_PROBE_STOPWORDS,
// SCORECARD_QUERY_TTL_DAYS, db, ragStmts).
import { strictSchoolKey } from "../cds/cds-store.js";
import crypto from "node:crypto";
import { safeJSON } from "./auth.js";

let deps;
export function bindBaselineColleges(serverDeps) { deps = serverDeps; }

// Small helper used by the endpoints above.
export function safeParse(json) {
  if (!json) return null;
  if (typeof json !== "string") return json;
  try { return JSON.parse(json); } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// FIRST-RUN OPERATOR SETUP (localhost + boot console token)
// ═══════════════════════════════════════════════════════════
// Lets an operator finish deployment config from the Setup UI (web /setup.html
// or the macOS app) instead of hand-editing .env:
//   • generate the PII-vault ENCRYPTION_KEY (server-side — the secret is NEVER
//     sent from the client; the client only triggers generation),
//   • save the College Scorecard (IPEDS) data API key.
// Guards: the request must originate from loopback AND carry the one-time
// SETUP_TOKEN printed to the server console at boot. ENCRYPTION_KEY is only
// ever WRITTEN on first run (when not already provided via env) and is NEVER
// rotated here — rotation would orphan all stored PII. Writes go through the
// atomic, backup-taking env-file helpers. Changes require a server restart to
// take effect (secrets are read at boot).

export function mapBaselineCollegeSummary(college) {
  return {
    unitId: college.unit_id, name: college.name, state: college.state,
    sat25: college.sat_25, sat75: college.sat_75, act25: college.act_25, act75: college.act_75,
    acceptanceRate: college.acceptance_rate != null ? Math.round(college.acceptance_rate * 1000) / 10 : null,
    enrollment: college.enrollment, tuitionIn: college.tuition_in, tuitionOut: college.tuition_out,
    gradRate: college.grad_rate_6yr, medianEarnings10yr: college.median_earnings_10yr,
    source: "Baseline data (offline mode)",
  };
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeCacheString(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return s || null;
}

export function normalizeStateList(states) {
  if (!Array.isArray(states)) return null;
  const normalized = states
    .map((s) => normalizeCacheString(s)?.toUpperCase() || null)
    .filter(Boolean)
    .sort();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeScorecardSearchPayload(payload = {}) {
  return {
    name: normalizeCacheString(payload.name),
    state: normalizeCacheString(payload.state)?.toUpperCase() || null,
    states: normalizeStateList(payload.states),
    minSAT: payload.minSAT != null ? Number(payload.minSAT) : null,
    maxTuition: payload.maxTuition != null ? Number(payload.maxTuition) : null,
    maxAcceptanceRate: payload.maxAcceptanceRate != null ? Number(payload.maxAcceptanceRate) : null,
    sizePreference: normalizeCacheString(payload.sizePreference),
    limit: Math.min(Math.max(Number(payload.limit || 20), 1), 100),
    page: Math.max(Number(payload.page || 0), 0),
  };
}

export function normalizeUnitId(value) {
  const s = String(value || "").trim();
  return s || null;
}

export function resolveBaselineCollegeRow(database, { unitId, schoolName } = {}) {
  const resolvedUnitId = normalizeUnitId(unitId);
  if (resolvedUnitId) {
    const byId = database.prepare("SELECT * FROM baseline_colleges WHERE unit_id = ?").get(resolvedUnitId);
    if (byId) return byId;
  }
  if (!schoolName) return null;

  const exact = database.prepare("SELECT * FROM baseline_colleges WHERE lower(name) = lower(?) LIMIT 1").get(schoolName);
  if (exact) return exact;

  // IPEDS names a flagship "Purdue University-Main Campus", so the bare
  // name a student types never matches it exactly, and by the extension
  // rule below a regional campus ("Purdue University Northwest", one extra
  // word) used to beat it (two). The suffix is no extension at all.
  const mainCampus = (key) => key.replace(/\s+main campus$/, "");
  const query = mainCampus(strictSchoolKey(schoolName));
  if (!query) return null;
  // Narrow with a LIKE on the most distinctive token (longest non-stopword),
  // not "university"/"of" which match thousands of rows.
  const tokens = query.split(" ").filter(Boolean);
  const probe = tokens.filter((t) => !deps.BASELINE_PROBE_STOPWORDS.has(t)).sort((a, b) => b.length - a.length)[0] || tokens[0];
  if (!probe) return null;

  const candidates = database
    .prepare("SELECT * FROM baseline_colleges WHERE lower(name) LIKE ? LIMIT 200")
    .all(`%${probe}%`);

  let best = null;
  let bestScore = -1;
  for (const row of candidates) {
    const cand = mainCampus(strictSchoolKey(row.name));
    if (!cand) continue;
    let score = -1;
    if (cand === query) {
      score = 100;
    } else if (cand.startsWith(`${query} `)) {
      // Prefix extension ("Columbia University" ⊂ "Columbia University in …").
      const extraTokens = cand.split(" ").length - query.split(" ").length;
      score = 80 - Math.min(40, extraTokens);
    } else {
      continue; // distinct school → refuse
    }
    // Tie-break toward rows that actually carry selectivity data.
    if (row.acceptance_rate != null) score += 2;
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return best;
}

export function normalizeComparePayload(unitIds) {
  return {
    unitIds: Array.isArray(unitIds)
      ? unitIds.map((id) => normalizeUnitId(id)).filter(Boolean).sort()
      : [],
  };
}

export function buildScorecardQueryCacheKey(kind, payload) {
  return crypto
    .createHash("sha256")
    .update(`${kind}|${stableStringify(payload)}`)
    .digest("hex");
}

export function pruneScorecardQueryCache() {
  try {
    deps.ragStmts.deleteScorecardQueryCacheOlderThan?.run(`-${deps.SCORECARD_QUERY_TTL_DAYS} days`);
  } catch {
    // Cache pruning is best-effort.
  }
}

export function getScorecardQueryCache(kind, payload) {
  pruneScorecardQueryCache();
  const key = buildScorecardQueryCacheKey(kind, payload);
  const row = deps.ragStmts.getScorecardQueryCache?.get(key);
  if (!row) return null;
  return {
    cacheKey: key,
    kind: row.cache_kind,
    fetchedAt: row.fetched_at,
    data: safeJSON(row.data_json, null),
  };
}

export function putScorecardQueryCache(kind, payload, data) {
  pruneScorecardQueryCache();
  const key = buildScorecardQueryCacheKey(kind, payload);
  deps.ragStmts.upsertScorecardQueryCache?.run(
    key,
    kind,
    JSON.stringify(payload),
    JSON.stringify(data),
  );
  return key;
}

export function collegeMatchesKeyword(college, keyword) {
  const normalized = String(keyword || "").trim().toLowerCase();
  if (!normalized) return true;
  const byName = String(college.name || "").toLowerCase();
  if (byName.includes(normalized)) return true;
  const stopWords = new Set(["of", "the", "and", "at", "for"]);
  const acronym = String(college.name || "").replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).filter(p => !stopWords.has(p.toLowerCase())).map(p => p[0]?.toUpperCase() || "").join("").toLowerCase();
  if (acronym && acronym === normalized.replace(/\./g, "")) return true;
  return byName.replace(/[^a-z0-9]+/g, " ").trim().includes(normalized);
}

export function matchesBaselineSizePreference(enrollment, sizePreference) {
  if (enrollment == null || !sizePreference) return true;
  if (sizePreference === "small") return enrollment < 5000;
  if (sizePreference === "medium") return enrollment >= 5000 && enrollment < 20000;
  if (sizePreference === "large") return enrollment >= 20000;
  return true;
}

export function buildBaselineCollegeSearchResponse(filters) {
  const safeLimit = Math.min(Math.max(parseInt(filters.limit || "20", 10) || 20, 1), 100);
  const safePage = Math.max(parseInt(filters.page || "0", 10) || 0, 0);
  let colleges = deps.db.prepare("SELECT * FROM baseline_colleges").all();
  if (filters.name) colleges = colleges.filter(c => collegeMatchesKeyword(c, filters.name));
  if (filters.state) colleges = colleges.filter(c => c.state === filters.state);
  if (filters.states?.length) colleges = colleges.filter(c => filters.states.includes(c.state));
  if (filters.minSAT) colleges = colleges.filter(c => (c.sat_75 ?? c.sat_25 ?? null) != null && (c.sat_75 ?? c.sat_25) >= filters.minSAT);
  if (filters.maxTuition) colleges = colleges.filter(c => c.tuition_in != null && c.tuition_in <= filters.maxTuition);
  if (filters.maxAcceptanceRate) colleges = colleges.filter(c => c.acceptance_rate != null && c.acceptance_rate <= filters.maxAcceptanceRate / 100);
  if (filters.sizePreference) colleges = colleges.filter(c => matchesBaselineSizePreference(c.enrollment, filters.sizePreference));

  colleges.sort((a, b) => {
    if (a.acceptance_rate == null && b.acceptance_rate != null) return 1;
    if (a.acceptance_rate != null && b.acceptance_rate == null) return -1;
    if (a.acceptance_rate != null && b.acceptance_rate != null && a.acceptance_rate !== b.acceptance_rate) return a.acceptance_rate - b.acceptance_rate;
    return a.name.localeCompare(b.name);
  });

  const start = safePage * safeLimit;
  return { results: colleges.slice(start, start + safeLimit).map(mapBaselineCollegeSummary), total: colleges.length, page: safePage, source: "Baseline data" };
}

export function withScorecardMeta(data, meta = {}) {
  return {
    ...data,
    cached: Boolean(meta.cached),
    stale: Boolean(meta.stale),
    fallback: Boolean(meta.fallback),
    fallbackReason: meta.fallbackReason || null,
    cacheKind: meta.cacheKind || null,
    cacheTtlDays: meta.cacheKind ? deps.SCORECARD_QUERY_TTL_DAYS : null,
    dataFreshness: meta.dataFreshness || (meta.stale ? "stale" : "current"),
  };
}
