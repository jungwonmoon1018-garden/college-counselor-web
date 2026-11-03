// ═══════════════════════════════════════════════════════════════════════
// BATCH JOBS — Scheduled batch processing
// ═══════════════════════════════════════════════════════════════════════
// Handles scheduled operations:
//   - Nightly baseline normalization
//   - Daily college profile cache refresh
//   - Daily domain monitoring + diff indexing
//   - Hourly stale fact expiration
//   - Daily retention cleanup
//   - Document auto-deletion (72h)
//   - Daily profile history compaction
//   - Hourly release of budget reservations a restart orphaned
// ═══════════════════════════════════════════════════════════════════════

import { expireOldFacts } from "./fact-store.js";
import { runRetentionCleanup } from "../storage/retention.js";
import { cleanExpiredDocuments } from "../storage/pii-vault.js";
import { compactProfileHistory } from "../storage/rag-schema.js";
import { releaseStaleReservations } from "../security/usage-budget.js";

// A reservation still 'reserved' after this long belongs to no live call.
// The adapter caps one call at LLM_CALL_TIMEOUT_MS (105 s by default), and a
// council reserves its four stages up front and runs them in turn, so the
// cutoff is six calls' worth with a 30-minute floor.
export function staleReservationAgeMs(env = process.env) {
  const callMs = Number(env.LLM_CALL_TIMEOUT_MS) > 0 ? Number(env.LLM_CALL_TIMEOUT_MS) : 105_000;
  return Math.max(30 * 60 * 1000, 6 * callMs);
}

// ─── Job registry ───
const jobs = new Map();
const intervals = new Map();

export function registerJob(name, fn, intervalMs, options = {}) {
  jobs.set(name, {
    name,
    fn,
    intervalMs,
    lastRun: null,
    lastResult: null,
    runCount: 0,
    enabled: options.enabled !== false,
    runOnStartup: options.runOnStartup || false,
  });
}

// ─── Start all registered jobs ───
export function startAllJobs() {
  for (const [name, job] of jobs) {
    if (!job.enabled) continue;

    if (job.runOnStartup) {
      runJob(name).catch((err) => console.error(`[BATCH] Startup run of ${name} failed:`, err.message));
    }

    const intervalId = setInterval(() => {
      runJob(name).catch((err) => console.error(`[BATCH] ${name} failed:`, err.message));
    }, job.intervalMs);

    intervals.set(name, intervalId);
    console.log(`[BATCH] Scheduled: ${name} (every ${formatInterval(job.intervalMs)})`);
  }
}

// ─── Stop all jobs ───
export function stopAllJobs() {
  for (const [name, intervalId] of intervals) {
    clearInterval(intervalId);
    console.log(`[BATCH] Stopped: ${name}`);
  }
  intervals.clear();
}

// ─── Run a single job ───
async function runJob(name) {
  const job = jobs.get(name);
  if (!job) return;

  const startTime = Date.now();
  try {
    const result = await job.fn();
    job.lastRun = new Date().toISOString();
    job.lastResult = { success: true, result, durationMs: Date.now() - startTime };
    job.runCount++;

    if (result && (result.deleted || result.expired || result.changed)) {
      console.log(`[BATCH] ${name}: completed in ${Date.now() - startTime}ms`, JSON.stringify(result));
    }
  } catch (err) {
    job.lastRun = new Date().toISOString();
    job.lastResult = { success: false, error: err.message, durationMs: Date.now() - startTime };
    job.runCount++;
    throw err;
  }
}

// ─── Register standard jobs ───
export function registerStandardJobs({ db, piiVault, factStmts, piiStmts, monitorStmts, retentionMode }) {
  // Hourly: expire old facts
  if (factStmts) {
    registerJob("expire_facts", () => expireOldFacts(factStmts), 60 * 60 * 1000, { runOnStartup: true });
  }

  // Every 6 hours: clean expired documents
  if (piiStmts) {
    registerJob("clean_documents", () => cleanExpiredDocuments(piiStmts), 6 * 60 * 60 * 1000, { runOnStartup: true });
  }

  // Daily: retention cleanup
  if (db) {
    registerJob("retention_cleanup", () => {
      const piiDb = piiVault?.db || null;
      return runRetentionCleanup(db, piiDb, retentionMode || "consumer");
    }, 24 * 60 * 60 * 1000, { runOnStartup: true });
  }

  // Daily and at boot: keep each student's newest profile snapshots and the
  // rows computed from them (storage/rag-schema.js compactProfileHistory).
  // Nothing pruned them before, and the history plus seven daily backups
  // was on course to fill the 1 GB disk.
  if (db && hasTable(db, "profile_snapshots")) {
    registerJob("profile_compaction", () => compactProfileHistory(db), 24 * 60 * 60 * 1000, { runOnStartup: true });
  }

  // Hourly: release budget reservations no live call holds. The boot sweep
  // (server.js) releases everything from before this process started; this
  // one catches a reservation whose release was lost while the process ran.
  if (db && hasTable(db, "usage_budget_reservations")) {
    registerJob("release_stale_reservations", () => {
      const { released } = releaseStaleReservations(db, { createdBefore: new Date(Date.now() - staleReservationAgeMs()) });
      return { released, changed: released > 0 };
    }, 60 * 60 * 1000, { runOnStartup: false });
  }

  // Daily: domain monitoring (02:00 UTC is handled by caller scheduling)
  if (monitorStmts) {
    registerJob("domain_monitor", async () => {
      const { runDailyMonitor } = await import("../colleges/domain-monitor.js");
      return runDailyMonitor(monitorStmts, { batchSize: 200, delayMs: 1000 });
    }, 24 * 60 * 60 * 1000, { enabled: false }); // Disabled by default; enable via config
  }
}

function hasTable(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch {
    return false;
  }
}

// ─── Get job status ───
export function getJobStatus() {
  const status = {};
  for (const [name, job] of jobs) {
    status[name] = {
      enabled: job.enabled,
      intervalMs: job.intervalMs,
      interval: formatInterval(job.intervalMs),
      lastRun: job.lastRun,
      lastResult: job.lastResult,
      runCount: job.runCount,
    };
  }
  return status;
}

function formatInterval(ms) {
  if (ms >= 24 * 60 * 60 * 1000) return `${ms / (24 * 60 * 60 * 1000)}d`;
  if (ms >= 60 * 60 * 1000) return `${ms / (60 * 60 * 1000)}h`;
  if (ms >= 60 * 1000) return `${ms / (60 * 1000)}m`;
  return `${ms / 1000}s`;
}
