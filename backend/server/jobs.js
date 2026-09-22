// server/jobs.js — the scheduled background work: the standard batch jobs,
// the opt-in and daily Common Data Set refreshes, the hourly due-checks of
// the two scouts, and the OpenRouter catalog refresh timers. Moved out of
// server.js on 2026-09-21; called from the same place, so what runs when at
// boot is unchanged. `deps` is server.js's routeDeps object of live getters.
import { registerJob, registerStandardJobs, startAllJobs } from "../scouts/batch-jobs.js";
import { backupDatabases } from "../storage/db-backup.js";
import { refreshAllCds, shouldRunCdsRefresh } from "../cds/cds-ingest-pipeline.js";
import crypto from "node:crypto";
import { SCOUT_DUE_CHECK_MS } from "../scouts/scout-cadence.js";
import { maybeRunModelCatalogScout, maybeRunPolicyScout } from "./schedulers.js";
import { OPENROUTER_CATALOG, configureOpenRouterCatalogCache, refreshOpenRouterCatalog, refreshOpenRouterTargets } from "../scouts/openrouter-model-refresh.js";
import path from "node:path";

export function registerServerJobs(deps) {
  // ═══════════════════════════════════════════════════════════
  // BATCH JOBS — scheduled background tasks
  // ═══════════════════════════════════════════════════════════
  registerStandardJobs({
    db: deps.db,
    piiVault: deps.piiVault,
    factStmts: deps.factStmts,
    piiStmts: deps.piiStmts,
    monitorStmts: deps.monitorStmts,
    retentionMode: deps.RETENTION_MODE,
  });

  // Opt-in auto-refresh of Common Data Set records (the daily domain_monitor
  // already watches official pages; this re-ingests the newest registered CDS
  // cycle). OFF by default because it does network I/O across many schools —
  // enable with AUTO_REFRESH_CDS=1, tune cycle via CDS_REFRESH_CYCLE. Only
  // data from operator-registered authoritative CDS links is ingested; nothing
  // is fabricated. AP concept data is a curated catalog (no live source).
  if (process.env.AUTO_REFRESH_CDS === "1") {
    const CDS_CYCLE = process.env.CDS_REFRESH_CYCLE || "2024-25";
    registerJob("cds_refresh", async () => {
      const { ingestBulk, getRepositoryIndex } = await import("../cds/cds-ingest-pipeline.js");
      const index = await getRepositoryIndex();
      const targets = index.map((e) => e.name).filter(Boolean);
      if (!targets.length) return;
      console.log(`[CDS-REFRESH] Auto-refreshing ${targets.length} school(s) to cycle ${CDS_CYCLE}…`);
      const results = await ingestBulk(deps.ragStmts, targets, { concurrency: 2, year: CDS_CYCLE });
      const ok = results.filter((r) => r.status === "ok" || r.status === "ok_with_overrides").length;
      console.log(`[CDS-REFRESH] Done: ${ok}/${results.length} ingested.`);
    }, 7 * 24 * 60 * 60 * 1000, { runOnStartup: false }); // weekly
    console.log(`[BOOT] AUTO_REFRESH_CDS enabled — weekly CDS re-ingest for cycle ${process.env.CDS_REFRESH_CYCLE || "2024-25"}.`);
  }

  // Daily CDS web-scrape from June 1 onward. New Common Data Sets publish across
  // the summer, so from June 1 through year-end we re-scrape the repository index
  // and re-ingest every school each day, preferring the newest cycle — keeping
  // College Fit grounded in the freshest CDS. Deterministic parse (no LLM/key).
  // Enabled by default; set CDS_DAILY_REFRESH=0 to disable.
  if (process.env.CDS_DAILY_REFRESH !== "0") {
    registerJob("cds_daily_refresh", async () => {
      if (!shouldRunCdsRefresh(Date.now())) return { skipped: "before June 1 (off-season)" };
      const concurrency = Number(process.env.CDS_REFRESH_CONCURRENCY || 3) || 3;
      const r = await refreshAllCds(deps.ragStmts, { concurrency });
      console.log(`[BATCH] cds_daily_refresh: ${r.total} schools`, JSON.stringify(r.byStatus));
      // Every record the refresh refused to overwrite goes to the audit log,
      // one event per school, so the counselor's log shows what needs a look.
      for (const held of r.heldBack || []) {
        console.warn(`[BATCH] cds_daily_refresh held back ${held.slug} (${held.year} over stored ${held.storedYear}): ${held.reasons.join("; ")}`);
        try { deps.stmts.insertAudit.run(crypto.randomUUID(), new Date().toISOString(), "cds_refresh_held_back", held.slug.slice(0, 12), `${held.slug} ${held.year} over ${held.storedYear}: ${held.reasons.join("; ")}`.slice(0, 500), null); } catch (err) { console.warn("[BATCH] audit write failed:", err.message); }
      }
      return { changed: true, ...r };
    }, 24 * 60 * 60 * 1000, { enabled: true, runOnStartup: false });
    console.log("[BOOT] CDS daily refresh scheduled (active June 1+; CDS_DAILY_REFRESH=0 to disable).");
  }

  // Automatic scouts run every two weeks (SCOUT_CADENCE_DAYS overrides). A
  // deploy restarts every timer, so instead of a two-week setInterval each
  // scout is checked hourly against its last completed run in the database
  // and runs once the cadence has elapsed — the same check runs shortly after
  // boot. Manual runs from the admin page never wait.
  //   • admissions_policy_scout — reads each tracked school's own admissions
  //     pages (test policy, plan deadlines, application fee), logs what
  //     changed, and refreshes the verified facts the chat and calendar read.
  //     Deterministic — no model, no key. POLICY_SCOUT=0 disables it.
  //   • model_catalog_scout — refreshes the OpenRouter catalog, then lists any
  //     new eligible models as per-tier options for the counselor to pick
  //     from. MODEL_SCOUT=0 disables it.
  if (process.env.POLICY_SCOUT !== "0") {
    registerJob("admissions_policy_scout", () => maybeRunPolicyScout("scheduled"), SCOUT_DUE_CHECK_MS, { enabled: true, runOnStartup: false });
    if (process.env.NODE_ENV !== "test") {
      const bootDelay = Number(process.env.POLICY_SCOUT_BOOT_DELAY_MS) > 0 ? Number(process.env.POLICY_SCOUT_BOOT_DELAY_MS) : 5 * 60 * 1000;
      setTimeout(() => {
        maybeRunPolicyScout("boot").catch((err) => console.warn("[policy-scout] boot run failed:", err?.message));
      }, bootDelay).unref();
    }
    console.log(`[BOOT] Admissions-policy scout scheduled every ${deps.SCOUT_CADENCE_DAYS} day(s), checked hourly (POLICY_SCOUT=0 to disable).`);
  }
  if (deps.MODEL_SCOUT_ENABLED) {
    registerJob("model_catalog_scout", () => maybeRunModelCatalogScout("scheduled"), SCOUT_DUE_CHECK_MS, { enabled: true, runOnStartup: false });
    console.log(`[BOOT] Model-catalog scout scheduled every ${deps.SCOUT_CADENCE_DAYS} day(s), checked hourly (MODEL_SCOUT=0 to disable).`);
  }

  // Daily copies of the three databases onto the persistent disk, seven
  // kept (storage/db-backup.js); one is taken at boot when the day has none.
  // Off under the test runner, whose servers point DATA_DIR at the real
  // local data folder while their databases are scratch files.
  registerJob("db_backup", () => backupDatabases(
    { counselor: deps.db, "pii-vault": deps.piiVault?.db || null, vectors: deps.vectorStore?.db || null },
    { dir: path.join(deps.DATA_DIR, "backups") },
  ), 24 * 60 * 60 * 1000, { enabled: process.env.NODE_ENV !== "test", runOnStartup: true });

  startAllJobs();
}

export function startModelCatalogRefresh(deps) {
  // 2b. OpenRouter live catalog refresh — fetch the full model list (ids,
  //     pricing, context) at boot and every 24h. This drives the BYOK model
  //     dropdown (GET /api/llm/openrouter/models) and budget pricing
  //     (usage-budget.js). If OpenRouter is unreachable we keep the last-known
  //     catalog and the static fallback list and retry next cycle.
  // The catalog is also the budget tracker's price table, so an empty
  // catalog means every model call is refused. A failed boot fetch now falls
  // back to the last-known catalog on disk, retries every five minutes until
  // OpenRouter answers, and the chat route triggers one refresh itself when
  // it finds the catalog empty (see ensureOpenRouterCatalog).
  configureOpenRouterCatalogCache(path.join(deps.DATA_DIR, "openrouter-catalog.json"));
  refreshOpenRouterCatalog()
    .then(() => maybeRunModelCatalogScout("boot", { refreshCatalog: false }).catch((err) => console.warn("[MODEL-SCOUT] boot run failed:", err?.message)))
    .catch(err => console.warn("[OR-CATALOG] Boot refresh threw:", err.message));
  setInterval(() => {
    refreshOpenRouterCatalog().catch(err => console.warn("[OR-CATALOG] Daily refresh threw:", err.message));
  }, deps.REFRESH_INTERVAL_MS).unref();
  setInterval(() => {
    if (OPENROUTER_CATALOG.reachable === true && OPENROUTER_CATALOG.models.length) return;
    refreshOpenRouterCatalog().catch(err => console.warn("[OR-CATALOG] Retry refresh threw:", err.message));
  }, 5 * 60 * 1000).unref();

  // 2c. OpenRouter recommended-model refresh — same 24h cadence, but migration
  //     is PROPOSE-ONLY (human approval via the BYOK "Update models" prompt). No
  //     student row is rewritten automatically for BYOK providers.
  refreshOpenRouterTargets({ reason: "boot" }).catch(err => console.warn("[OR-MIGRATE] Boot refresh threw:", err.message));
  setInterval(() => {
    refreshOpenRouterTargets({ reason: "daily" }).catch(err => console.warn("[OR-MIGRATE] Daily refresh threw:", err.message));
  }, deps.REFRESH_INTERVAL_MS).unref();
}
