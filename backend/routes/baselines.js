// routes/baselines.js — the /api/baselines routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (RETENTION_MODE, db, factStmts, orchestrationCatalog, vectorStmts).
import { getFactStoreStats } from "../scouts/fact-store.js";
import { getVectorStoreStats } from "../storage/vector-store.js";
import { getJobStatus } from "../scouts/batch-jobs.js";

export function registerBaselinesRoutes(app, deps) {
  // ═══════════════════════════════════════════════════════════
  // BASELINES STATUS
  // ═══════════════════════════════════════════════════════════

  app.get("/api/baselines/status", (_req, res) => {
    try {
      const gpaCount = deps.db.prepare("SELECT COUNT(*) as c FROM baseline_gpa").get().c;
      const satCount = deps.db.prepare("SELECT COUNT(*) as c FROM baseline_sat").get().c;
      const actCount = deps.db.prepare("SELECT COUNT(*) as c FROM baseline_act").get().c;
      const ecCount = deps.db.prepare("SELECT COUNT(*) as c FROM baseline_ec").get().c;
      const collegeCount = deps.db.prepare("SELECT COUNT(*) as c FROM baseline_colleges").get().c;
      const snapshotCount = deps.db.prepare("SELECT COUNT(*) as c FROM profile_snapshots").get().c;

      const factStats = getFactStoreStats(deps.factStmts);
      const vectorStats = getVectorStoreStats(deps.vectorStmts);
      const jobStatus = getJobStatus();

      const gpaYear = deps.db.prepare("SELECT MAX(year) as y FROM baseline_gpa").get()?.y || null;
      const collegeYear = deps.db.prepare("SELECT MAX(data_year) as y FROM baseline_colleges").get()?.y || null;
      const currentYear = new Date().getFullYear();

      function checkFreshness(label, dataYear, count) {
        if (!dataYear || count === 0) return { label, count, dataYear: null, status: "missing", stale: true };
        const isStale = currentYear - dataYear > 1;
        return { label, count, dataYear, status: isStale ? "stale" : "current", stale: isStale };
      }

      const datasets = [
        checkFreshness("GPA distributions", gpaYear, gpaCount),
        checkFreshness("SAT distributions", deps.db.prepare("SELECT MAX(year) as y FROM baseline_sat").get()?.y, satCount),
        checkFreshness("ACT distributions", deps.db.prepare("SELECT MAX(year) as y FROM baseline_act").get()?.y, actCount),
        checkFreshness("EC benchmarks", deps.db.prepare("SELECT MAX(data_year) as y FROM baseline_ec").get()?.y, ecCount),
        checkFreshness("College profiles", collegeYear, collegeCount),
      ];

      res.json({
        baselines: { gpa: gpaCount, sat: satCount, act: actCount, ec: ecCount, colleges: collegeCount },
        snapshots: snapshotCount,
        factStore: factStats,
        vectorStore: vectorStats,
        batchJobs: jobStatus,
        orchestration: {
          fafsaCorpusReady: !!deps.orchestrationCatalog.fafsa?.ready,
          fafsaCycle: deps.orchestrationCatalog.fafsa?.cycle || null,
          admissionsDeadlinesLoaded: deps.orchestrationCatalog.deadlines?.entries?.length || 0,
        },
        status: gpaCount > 0 && satCount > 0 && collegeCount > 0 ? "ready" : "needs_seeding",
        freshness: { datasets, staleCount: datasets.filter(d => d.stale).length, lastChecked: new Date().toISOString() },
        retentionMode: deps.RETENTION_MODE,
      });
    } catch (err) {
      res.status(500).json({ error: "Status check failed" });
    }
  });
}
