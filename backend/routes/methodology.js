// routes/methodology.js — the /api/methodology routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (SCORECARD_API_KEY, apiLimiter).
import { buildMethodology } from "../shared/methodology.js";
import { OPENROUTER_CATALOG, OPENROUTER_STATUS } from "../scouts/openrouter-model-refresh.js";
import { getJobStatus } from "../scouts/batch-jobs.js";

export function registerMethodologyRoutes(app, deps) {
  // GET /api/llm/providers — frontend-facing provider catalog
  // Returns the list of supported LLM providers with their key prefix hints,
  // default base URLs (where applicable), known models, and tier defaults.
  // No auth required — this is a read-only registry.
  // GET /api/methodology — full transparency surface: EC factor weights, scoring
  // logic, narrative-quality policy, data sources + freshness, and model-
  // migration status. Read-only, no auth — the whole point is openness.
  app.get("/api/methodology", deps.apiLimiter, (_req, res) => {
    try {
      const m = buildMethodology({
        providerMigration: { openrouter: OPENROUTER_STATUS },
        scorecardConfigured: !!deps.SCORECARD_API_KEY,
        cdsCycleLatest: process.env.CDS_REFRESH_CYCLE || "2025-26",
        baselineYear: 2024,
        domainMonitorDaily: process.env.ENABLE_DOMAIN_MONITOR === "1",
        openRouterCatalog: { lastFetched: OPENROUTER_CATALOG.lastFetched, count: OPENROUTER_CATALOG.models.length, reachable: OPENROUTER_CATALOG.reachable },
        jobs: getJobStatus(),
      });
      res.json(m);
    } catch (err) {
      console.error("[methodology] error:", err.message);
      res.status(500).json({ error: "Failed to build methodology" });
    }
  });
}
