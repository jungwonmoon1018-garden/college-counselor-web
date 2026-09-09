// ═══════════════════════════════════════════════════════════════════════
// tests/competition-research.test.js — prestige research + cache behavior
// ═══════════════════════════════════════════════════════════════════════
// The research module has three gated paths:
//   1. TTL-cache hit   — returns immediately, no LLM, cached: true.
//   2. Benchmark/catalog hit — seeded/official prestige, no web call.
//   3. OpenRouter      — calls callLLM with the web plugin enabled
//                        (plugins:[{id:"web"}]), parses the JSON, caches 30d.
// Non-OpenRouter providers short-circuit with source: "unavailable" so the
// vectorizer never crashes when only an OpenAI/Google key is configured.
// ═══════════════════════════════════════════════════════════════════════

import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import {
  researchCompetitionPrestige,
  computePrestigeCacheKey,
  normalizeActivityName,
  searchCompetitionCatalog,
  findBestCompetitionCatalogPrestige,
  findCatalogMatchInText,
  isReputableSourceUrl,
  REPUTABLE_DOMAINS,
  OFFICIAL_COMPETITION_SOURCES,
} from "../competition-research.js";
import { initRAGTables, prepareRAGStatements } from "../rag-engine.js";

function freshStmts() {
  const db = new Database(":memory:");
  initRAGTables(db);
  return { db, stmts: prepareRAGStatements(db) };
}

// ─── Normalization + cache key ─────────────────────────────────────────

test("normalizeActivityName lowercases and collapses whitespace/punctuation", () => {
  assert.equal(normalizeActivityName("  AMC 10/12 — 2024  "), "amc 10 12 2024");
  assert.equal(normalizeActivityName("USAMO, Qualifier!"), "usamo qualifier");
  assert.equal(normalizeActivityName(null), "");
  assert.equal(normalizeActivityName(undefined), "");
});

test("computePrestigeCacheKey is stable on equivalent inputs", () => {
  const k1 = computePrestigeCacheKey("USAMO Qualifier", "national");
  const k2 = computePrestigeCacheKey(" usamo  QUALIFIER ", "National");
  assert.equal(k1, k2);
  const k3 = computePrestigeCacheKey("USAMO Qualifier", "regional");
  assert.notEqual(k1, k3, "different levelHint must produce different key");
});

// ─── Reputable-domain allowlist ────────────────────────────────────────

test("REPUTABLE_DOMAINS is restricted to official competition / gov / school hosts", () => {
  assert.ok(REPUTABLE_DOMAINS.includes("maa.org"));
  assert.ok(REPUTABLE_DOMAINS.includes("usaco.org"));
  assert.ok(REPUTABLE_DOMAINS.includes("societyforscience.org"));
  assert.ok(REPUTABLE_DOMAINS.includes("firstinspires.org"));
  assert.ok(REPUTABLE_DOMAINS.includes("ci.uky.edu"));
  assert.ok(!REPUTABLE_DOMAINS.includes("en.wikipedia.org"));
  assert.ok(!REPUTABLE_DOMAINS.includes("collegevine.com"));
  assert.ok(!REPUTABLE_DOMAINS.includes("ivywise.com"));
});

test("official competition catalog returns source-backed prestige matches", () => {
  assert.ok(OFFICIAL_COMPETITION_SOURCES.length >= 10);
  const [usaco] = searchCompetitionCatalog("USACO Platinum finalist", { limit: 3 });
  assert.equal(usaco.activityId, "usaco");
  assert.ok(usaco.score >= 0.82);
  assert.ok(usaco.sourcesCited.every(isReputableSourceUrl));

  const best = findBestCompetitionCatalogPrestige("HOSA ILC medallion winner");
  assert.equal(best.activityId, "hosa");
  assert.ok(best.score >= 0.8);
});

test("RAG statements expose bulk cache-memory readers for prestige and components", () => {
  const { stmts } = freshStmts();
  const prestigeKey = computePrestigeCacheKey("USACO Platinum", "national");

  stmts.upsertPrestigeCache.run(
    prestigeKey,
    "USACO Platinum",
    "national",
    0.82,
    "Matched official competition catalog.",
    JSON.stringify(["https://usaco.org/current/current/index.php?page=details"]),
    "catalog",
    null,
    null,
    JSON.stringify({ score: 0.82 }),
  );
  stmts.upsertComponentCache.run(
    "component-cache-key",
    "prestige",
    0.82,
    JSON.stringify({ source: "catalog" }),
    "catalog",
    null,
    null,
    "{\"activityName\":\"USACO Platinum\"}",
  );

  assert.equal(Number(stmts.countPrestigeCache.get().total), 1);
  assert.equal(Number(stmts.countComponentCache.get().total), 1);
  assert.equal(Number(stmts.countComponentCacheByFactor.get("prestige").total), 1);
  assert.equal(stmts.listPrestigeCacheRecent.all(10).length, 1);
  assert.equal(stmts.listComponentCacheRecentByFactor.all("prestige", 10).length, 1);
});

// ─── Path 1: cache hit ─────────────────────────────────────────────────

test("returns cached prestige on TTL hit without calling the adapter", async () => {
  const { stmts } = freshStmts();
  const key = computePrestigeCacheKey("AIME", "national");

  // Pre-seed a fresh cache row.
  stmts.upsertPrestigeCache.run(
    key, "AIME", "national", 0.72,
    "Seeded from test.",
    JSON.stringify(["https://maa.org/aime"]),
    "catalog", null, null,
    JSON.stringify({ score: 0.72 }),
  );

  // Caller-supplied network hooks are ignored on a reviewed cache hit.
  const r = await researchCompetitionPrestige({
    activityName: "AIME",
    levelHint: "national",
    stmts,
    adapter: { provider: "openrouter", apiKey: "sk-or-x", model: "z-ai/glm-5.1" },
    options: {
      fetchImpl: async () => { throw new Error("should not fetch on cache hit"); },
    },
  });
  assert.equal(r.cached, true);
  assert.equal(r.score, 0.72);
  assert.equal(r.source, "catalog");
});

// ─── Path 2: benchmark short-circuit ───────────────────────────────────

test("benchmark hit short-circuits lookup and caches result", async () => {
  const { stmts } = freshStmts();
  const r = await researchCompetitionPrestige({
    activityName: "USAJMO qualifier",
    levelHint: "national",
    benchmarkHit: { level: "USAJMO qualifier", prestige_score: 0.80 },
    stmts,
    adapter: { provider: "openrouter", apiKey: "sk-or-x", model: "z-ai/glm-5.1" },
    options: {
      fetchImpl: async () => { throw new Error("should not fetch on benchmark hit"); },
    },
  });
  assert.equal(r.source, "benchmark");
  assert.equal(r.score, 0.80);
  assert.equal(r.cached, false);

  // The benchmark result should now be cached — a second call should hit cache.
  const r2 = await researchCompetitionPrestige({
    activityName: "USAJMO qualifier",
    levelHint: "national",
    stmts,
    adapter: { provider: "openrouter", apiKey: "sk-or-x", model: "z-ai/glm-5.1" },
    options: {
      fetchImpl: async () => { throw new Error("should not fetch on second call either"); },
    },
  });
  assert.equal(r2.cached, true);
  assert.equal(r2.source, "benchmark");
});

test("official catalog hit caches result without an adapter", async () => {
  const { stmts } = freshStmts();
  const r = await researchCompetitionPrestige({
    activityName: "USACO Platinum",
    stmts,
    adapter: null,
    options: {
      fetchImpl: async () => { throw new Error("catalog hit should not fetch"); },
    },
  });
  assert.equal(r.source, "catalog");
  assert.ok(r.score >= 0.82);
  assert.ok(r.sourcesCited.every(isReputableSourceUrl));

  const r2 = await researchCompetitionPrestige({
    activityName: "USACO Platinum",
    stmts,
    adapter: null,
    options: {
      fetchImpl: async () => { throw new Error("cached catalog hit should not fetch"); },
    },
  });
  assert.equal(r2.cached, true);
  assert.equal(r2.source, "catalog");
});

// ─── Path 3: non-Anthropic → unavailable ───────────────────────────────

test("unrecognized activity remains unavailable regardless of adapter", async () => {
  const { stmts } = freshStmts();
  const r = await researchCompetitionPrestige({
    activityName: "Some Obscure Contest",
    levelHint: "regional",
    stmts,
    adapter: { provider: "openai", apiKey: "sk-x", model: "gpt-4o-mini" },
  });
  assert.equal(r.source, "unavailable");
  assert.equal(r.score, 0);
  assert.equal(r.cached, false);
});

test("missing adapter returns source:unavailable without throwing", async () => {
  const { stmts } = freshStmts();
  const r = await researchCompetitionPrestige({
    activityName: "Some Obscure Contest",
    levelHint: "regional",
    stmts,
    adapter: null,
  });
  assert.equal(r.source, "unavailable");
});

test("unknown competition stays deterministic and never fetches", async () => {
  const { stmts } = freshStmts();
  let fetched = false;
  const result = await researchCompetitionPrestige({
    activityName: "Uncataloged Engineering Challenge",
    levelHint: "national",
    stmts,
    adapter: { provider: "openrouter", apiKey: "sk-or-x" },
    options: { fetchImpl: async () => { fetched = true; } },
  });
  assert.equal(fetched, false);
  assert.equal(result.source, "unavailable");
  assert.equal(result.score, 0);
  assert.match(result.rationale, /Nothing in the reviewed benchmarks or the official competition catalog/);
});

test("legacy model-research cache rows are ignored", async () => {
  const { stmts } = freshStmts();
  const key = computePrestigeCacheKey("Old Model Research", null);
  stmts.upsertPrestigeCache.run(
    key, "Old Model Research", null, 0.99, "old model claim", JSON.stringify([]),
    "research", "openrouter", "old/model", JSON.stringify({ score: 0.99 }),
  );
  const result = await researchCompetitionPrestige({
    activityName: "Old Model Research",
    stmts,
  });
  assert.equal(result.source, "unavailable");
  assert.equal(result.score, 0);
});

// ─── Invalid input ─────────────────────────────────────────────────────

test("missing activityName or stmts returns invalid_input source", async () => {
  const { stmts } = freshStmts();
  const r1 = await researchCompetitionPrestige({ activityName: "", stmts });
  assert.equal(r1.source, "invalid_input");
  const r2 = await researchCompetitionPrestige({ activityName: "Foo", stmts: null });
  assert.equal(r2.source, "invalid_input");
});

// ─── The whole record: description, awards, role, attachments ──────────

test("a competition named only in the description is read at the level the description states", async () => {
  const { stmts } = freshStmts();
  const r = await researchCompetitionPrestige({
    activityName: "Math Team",
    stmts,
    evidence: { description: "Qualified for AIME with a 108 on the AMC 12; weekly problem sessions", role: "Member" },
  });
  assert.equal(r.source, "catalog");
  assert.equal(r.catalogMatch.activityId, "math_olympiad");
  assert.equal(r.level, "AIME qualifier");
  assert.equal(r.matchedIn, "description");
  assert.equal(r.score, 0.72);
  assert.match(r.rationale, /read at the "AIME qualifier" level from your description/);
  assert.match(r.rationale, /The next level in this catalog, "USAJMO\/USAMO qualifier", reads at 0\.92/);
  assert.ok(r.sourcesCited.length > 0 && r.sourcesCited.every(isReputableSourceUrl));
});

test("the name wins over the description, and the level comes from everything the student wrote", async () => {
  const { stmts } = freshStmts();
  const r = await researchCompetitionPrestige({
    activityName: "USACO",
    stmts,
    evidence: "Promoted to the Gold division in December",
  });
  assert.equal(r.source, "catalog");
  assert.equal(r.catalogMatch.activityId, "usaco");
  assert.equal(r.matchedIn, "name");
  assert.equal(r.level, "USACO Gold");
  assert.equal(r.score, 0.65);
  assert.match(r.rationale, /from the activity's name/);
});

test("a changed description is a different read: the cache key carries the evidence, and an unmatched activity is told what to write", async () => {
  const { stmts } = freshStmts();
  const first = await researchCompetitionPrestige({ activityName: "Science Club", stmts, evidence: { description: "Weekly meetings and demos" } });
  assert.equal(first.source, "unavailable");
  assert.equal(first.score, 0);
  assert.match(first.rationale, /matches "Science Club" or its description/);
  assert.match(first.rationale, /name it and the level you reached in the activity description/);

  const second = await researchCompetitionPrestige({ activityName: "Science Club", stmts, evidence: { description: "Regeneron ISEF finalist in 2026 for a water-quality sensor" } });
  assert.equal(second.source, "catalog");
  assert.equal(second.cached, false);
  assert.equal(second.catalogMatch.activityId, "regeneron_isef");
  assert.equal(second.level, "ISEF finalist");
  assert.equal(second.matchedIn, "description");

  const again = await researchCompetitionPrestige({ activityName: "Science Club", stmts, evidence: { description: "Regeneron ISEF finalist in 2026 for a water-quality sensor" } });
  assert.equal(again.cached, true);
  assert.equal(again.level, "ISEF finalist");
  assert.equal(again.matchedIn, "description");

  assert.notEqual(computePrestigeCacheKey("Science Club", null, "a"), computePrestigeCacheKey("Science Club", null, "b"));
  assert.equal(computePrestigeCacheKey("Science Club", null), computePrestigeCacheKey("science  club", ""));
});

test("a benchmark read cites the organizer and says where the level was found", async () => {
  const { stmts } = freshStmts();
  const r = await researchCompetitionPrestige({
    activityName: "Math Team",
    stmts,
    benchmarkHit: {
      activity_id: "math_olympiad",
      activity_name: "Math Olympiad (AMC/AIME/USAMO/IMO)",
      level: "AIME qualifier",
      prestige_score: 0.72,
      next: { level: "USAMO qualifier", prestige_score: 0.92 },
      matchedIn: "description",
    },
    evidence: { description: "Qualified for AIME" },
  });
  assert.equal(r.source, "benchmark");
  assert.equal(r.score, 0.72);
  assert.match(r.rationale, /^Matched the seeded Math Olympiad \(AMC\/AIME\/USAMO\/IMO\) benchmark at the "AIME qualifier" level from your description\./);
  assert.match(r.rationale, /AIME qualification is a selective national math achievement/);
  assert.match(r.rationale, /The next level, "USAMO qualifier", reads at 0\.92\./);
  assert.ok(r.sourcesCited.some((u) => u.includes("maa.org")));
  assert.equal(r.catalogMatch.activityId, "math_olympiad");
  assert.equal(r.level, "AIME qualifier");
});

test("catalog names and level words match whole words only", () => {
  assert.equal(findCatalogMatchInText("A kimono exhibit and a limo ride"), null);
  const hit = findCatalogMatchInText("Placed at the state science olympiad tournament");
  assert.equal(hit.entry.id, "science_olympiad");
  assert.equal(hit.alias, "science olympiad");
});
