// routes/ec-research.js — the /api/ec competition search, the research cache
// memory, the prestige routes and the component cache. Split out of routes/ec.js on 2026-09-20; `deps` is the server's
// routeDeps object of live getters.
import { OFFICIAL_COMPETITION_SOURCES, PRESTIGE_TTL_DAYS, REPUTABLE_DOMAINS, computePrestigeCacheKey, normalizeActivityName, researchCompetitionPrestige, searchCompetitionCatalog } from "../competition-research.js";
import { STRENGTH_FACTORS, buildDefaultLLMClient, recomputeStudentECStrengthVectors } from "../ec-strength-vectorizer.js";
import { getActiveNarrative } from "../narrative-store.js";

export function registerEcResearchRoutes(app, deps) {
  // ═══════════════════════════════════════════════════════════
  // EC PRESTIGE ENDPOINTS (counselor-gated)
  // ═══════════════════════════════════════════════════════════

  // GET /api/ec/prestige/:activityName — debug read of the cached prestige
  // row for a named activity. Does NOT trigger a web_search; returns 404 if
  // the activity has never been researched. Counselor-auth-gated because
  // the cache is shared across all students and so is not PII-scoped.
  // POST /api/ec/competitions/search - official-source prestige lookup tool.
  // Body accepts either `{ query, levelHint? }` or `{ activities: [{ name,
  // levelHint? }] }`. With cacheResults=true (default), each item is written
  // into the shared RAG prestige cache via researchCompetitionPrestige().
  app.post("/api/ec/competitions/search", deps.requireCounselorAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const cacheResults = body.cacheResults !== false;
      const levelHint = typeof body.levelHint === "string" ? body.levelHint.trim() : null;
      const studentId = typeof body.studentId === "string" ? body.studentId.trim() : null;

      let items = [];
      if (Array.isArray(body.activities)) {
        items = body.activities
          .map((a) => ({
            name: String(a?.name || a?.activityName || "").trim(),
            levelHint: String(a?.levelHint || levelHint || "").trim() || null,
          }))
          .filter((a) => a.name);
      } else if (Array.isArray(body.activityNames)) {
        items = body.activityNames
          .map((name) => ({ name: String(name || "").trim(), levelHint }))
          .filter((a) => a.name);
      } else if (body.query) {
        items = [{ name: String(body.query || "").trim(), levelHint }];
      }

      if (items.length === 0) {
        return res.status(400).json({
          error: "Provide query, activityNames[], or activities[].",
        });
      }
      if (items.length > 50) {
        return res.status(400).json({ error: "At most 50 activities per request." });
      }

      const prestigeAdapter = studentId ? deps.resolvePrestigeAdapter(studentId) : null;
      const results = [];
      for (const item of items) {
        const matches = searchCompetitionCatalog(item.name, {
          levelHint: item.levelHint,
          limit: Number(body.limit || 5),
        });
        let cachedResult = null;
        if (cacheResults) {
          cachedResult = await researchCompetitionPrestige({
            activityName: item.name,
            levelHint: item.levelHint || matches[0]?.level || null,
            stmts: deps.ragStmts,
            adapter: prestigeAdapter,
          });
        }
        results.push({
          query: item.name,
          levelHint: item.levelHint,
          matches,
          cachedResult,
        });
      }

      res.json({
        ok: true,
        count: results.length,
        cacheResults,
        catalogCount: OFFICIAL_COMPETITION_SOURCES.length,
        reputableDomains: REPUTABLE_DOMAINS,
        results,
      });
    } catch (err) {
      console.error("[EC competitions] search error:", err.message);
      res.status(500).json({ error: "Competition search failed" });
    }
  });

  // GET /api/ec/cache-memory — bulk read of the shared EC prestige cache plus
  // the five-factor component cache, so EC agents can consume cache memory
  // "all at once" without retriggering research or recompute.
  app.get("/api/ec/cache-memory", deps.requireCounselorAuth, (req, res) => {
    try {
      const limit = Math.max(1, Math.min(250, Number(req.query.limit || 25)));
      const factorQuery = typeof req.query.factor === "string" ? req.query.factor.trim() : "";
      const factor = factorQuery || null;
      const includeFailed = String(req.query.includeFailed || "").toLowerCase() === "true";

      if (factor && !STRENGTH_FACTORS.includes(factor)) {
        return res.status(400).json({
          error: `factor must be one of: ${STRENGTH_FACTORS.join(", ")}`,
        });
      }

      const prestigeTotal = Number(deps.ragStmts.countPrestigeCache?.get()?.total || 0);
      const componentTotal = Number(deps.ragStmts.countComponentCache?.get()?.total || 0);
      let prestigeRows = deps.ragStmts.listPrestigeCacheRecent?.all(limit * 4) || [];
      if (!includeFailed) {
        prestigeRows = prestigeRows.filter((row) => row?.source !== "research_failed");
      }
      prestigeRows = prestigeRows.slice(0, limit);

      const selectedFactors = factor ? [factor] : STRENGTH_FACTORS;
      const rowsByFactor = {};
      for (const factorName of selectedFactors) {
        const rows = deps.ragStmts.listComponentCacheRecentByFactor?.all(factorName, limit) || [];
        rowsByFactor[factorName] = rows.map((row) => ({
          cacheKey: row.cache_key,
          factor: row.factor,
          score: Number(row.score) || 0,
          source: row.source || null,
          provider: row.provider || null,
          model: row.model || null,
          reasoning: deps.safeJSON(row.reasoning_json, null),
          computedAt: row.created_at || null,
        }));
      }

      res.json({
        ok: true,
        limit,
        includeFailed,
        prestige: {
          ttlDays: PRESTIGE_TTL_DAYS,
          totalRows: prestigeTotal,
          returnedRows: prestigeRows.length,
          rows: prestigeRows.map((row) => {
            const ageMs = Date.now() - Date.parse(row.created_at || 0);
            const ageDays = Number.isFinite(ageMs) ? Math.floor(ageMs / 86_400_000) : null;
            return {
              cacheKey: row.cache_key,
              activityName: row.activity_name,
              normalizedName: normalizeActivityName(row.activity_name),
              levelHint: row.level_hint,
              score: Number(row.score) || 0,
              source: row.source || null,
              rationale: row.rationale || null,
              sourcesCited: deps.safeJSON(row.sources_json, []) || [],
              provider: row.provider || null,
              model: row.model || null,
              fetchedAt: row.created_at || null,
              ageDays,
              expired: ageDays != null && ageDays > PRESTIGE_TTL_DAYS,
            };
          }),
        },
        components: {
          factors: selectedFactors,
          totalRows: componentTotal,
          perFactorLimit: limit,
          rowsByFactor,
          countsByFactor: Object.fromEntries(
            selectedFactors.map((factorName) => [
              factorName,
              Number(deps.ragStmts.countComponentCacheByFactor?.get(factorName)?.total || 0),
            ]),
          ),
        },
      });
    } catch (err) {
      console.error("[EC cache-memory] get error:", err.message);
      res.status(500).json({ error: "EC cache memory lookup failed" });
    }
  });

  app.get("/api/ec/prestige/:activityName", deps.requireCounselorAuth, (req, res) => {
    try {
      const activityName = String(req.params.activityName || "").trim();
      if (!activityName) {
        return res.status(400).json({ error: "activityName path param required" });
      }
      const levelHint = typeof req.query.level === "string" ? req.query.level.trim() : null;

      // Prefer the exact (name, level) cache key; fall back to the latest
      // row for the name.
      const key = computePrestigeCacheKey(activityName, levelHint);
      let row = deps.ragStmts.getPrestigeCache.get(key);
      if (!row && !levelHint) {
        row = deps.ragStmts.getPrestigeCacheByName.get(activityName);
      }

      if (!row) {
        return res.status(404).json({
          error: "No cached prestige row for this activity.",
          activityName,
          normalizedName: normalizeActivityName(activityName),
          ttlDays: PRESTIGE_TTL_DAYS,
        });
      }

      const ageMs = Date.now() - Date.parse(row.created_at || 0);
      const ageDays = Number.isFinite(ageMs) ? Math.floor(ageMs / 86_400_000) : null;
      const expired = ageDays != null && ageDays > PRESTIGE_TTL_DAYS;

      res.json({
        ok: true,
        activityName: row.activity_name,
        levelHint: row.level_hint,
        score: Number(row.score) || 0,
        source: row.source || null,
        rationale: row.rationale || null,
        sourcesCited: deps.safeJSON(row.sources_json, []) || [],
        provider: row.provider || null,
        model: row.model || null,
        fetchedAt: row.created_at,
        ageDays,
        expired,
        ttlDays: PRESTIGE_TTL_DAYS,
      });
    } catch (err) {
      console.error("[EC prestige] get error:", err.message);
      res.status(500).json({ error: "Prestige lookup failed" });
    }
  });

  // POST /api/ec/prestige/recompute — force a fresh prestige research call.
  // Body `{ studentId: string, ecName?: string }`:
  //   • studentId required — identifies whose BYOK (if any) pays for the
  //     web_search call.
  //   • ecName optional — if provided, invalidates just that EC's prestige
  //     cache row(s); otherwise clears every EC's prestige cache for the
  //     student and re-runs.
  // After invalidation, re-invokes recomputeStudentECStrengthVectors so the
  // ec_strength_vectors table is rewritten with the fresh prestige.
  app.post("/api/ec/prestige/recompute", deps.requireCounselorAuth, async (req, res) => {
    try {
      const { studentId, ecName } = req.body || {};
      if (!studentId || typeof studentId !== "string") {
        return res.status(400).json({ error: "studentId required" });
      }

      const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
      if (!snap) return res.status(404).json({ error: "No profile snapshot for student" });

      let activities = deps.safeParseJSON(snap.activities_json, []);
      if (!Array.isArray(activities)) activities = [];

      if (ecName) {
        activities = activities.filter((a) => a?.name === ecName);
        if (activities.length === 0) {
          return res.status(404).json({ error: `No EC named "${ecName}" for this student` });
        }
      }

      // Invalidate prestige cache rows for the affected activities. We delete
      // by activity_name so every (name, level_hint) variant gets cleared.
      let invalidated = 0;
      for (const ec of activities) {
        if (!ec?.name) continue;
        try {
          const r = deps.ragStmts.deletePrestigeByName.run(ec.name);
          invalidated += r?.changes || 0;
        } catch {
          // Non-fatal.
        }
      }

      const active = getActiveNarrative(deps.ragStmts.narrative, studentId);
      const prestigeAdapter = deps.resolvePrestigeAdapter(studentId);
      const result = await recomputeStudentECStrengthVectors(
        deps.ragStmts.strength, studentId,
        {
          activities,
          narrative: active?.narrativeText || null,
          narrativeThemes: active?.themes || [],
          narrativeHash: active?.hash || null,
          narrativeId: active?.id || null,
          majorInterest: snap.major_interest || null,
          llmClient: buildDefaultLLMClient(deps.ragStmts.narrativeFitCache),
          prestigeAdapter,
          ragStmts: deps.ragStmts,
        },
      );

      res.json({
        ok: true,
        studentId,
        ecName: ecName || null,
        invalidatedRows: invalidated,
        prestigeAvailable: !!prestigeAdapter,
        ...result,
        recomputedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[EC prestige] recompute error:", err.message);
      res.status(500).json({ error: "Prestige recompute failed" });
    }
  });

  // DELETE /api/ec/component-cache — admin reset for the five-factor
  // component cache. Body `{ factor: string, olderThanDays?: number }`.
  //   • factor required; one of STRENGTH_FACTORS.
  //   • olderThanDays optional — when provided, only rows older than that
  //     age are deleted (used for manual TTL enforcement); otherwise every
  //     row for the factor is cleared.
  app.delete("/api/ec/component-cache", deps.requireCounselorAuth, (req, res) => {
    try {
      const { factor, olderThanDays } = req.body || {};
      if (!factor || !STRENGTH_FACTORS.includes(factor)) {
        return res.status(400).json({
          error: `factor required; must be one of: ${STRENGTH_FACTORS.join(", ")}`,
        });
      }

      let changes = 0;
      if (olderThanDays !== undefined && olderThanDays !== null) {
        const days = Number(olderThanDays);
        if (!Number.isFinite(days) || days < 0) {
          return res.status(400).json({ error: "olderThanDays must be a non-negative number" });
        }
        // SQLite modifier: negative → subtract from 'now' in deleteComponentCacheOlderThan
        const modifier = `-${Math.floor(days)} days`;
        const r = deps.ragStmts.deleteComponentCacheOlderThan.run(factor, modifier);
        changes = r?.changes || 0;
      } else {
        const r = deps.ragStmts.deleteComponentCacheByFactor.run(factor);
        changes = r?.changes || 0;
      }

      res.json({
        ok: true,
        factor,
        olderThanDays: olderThanDays ?? null,
        deleted: changes,
      });
    } catch (err) {
      console.error("[EC component-cache] delete error:", err.message);
      res.status(500).json({ error: "Component cache delete failed" });
    }
  });
}
