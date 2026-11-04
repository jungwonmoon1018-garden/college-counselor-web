// ═══════════════════════════════════════════════════════════════════════
// CDS REFRESH SCHEDULE — when the June-December daily Common Data Set
// refresh is due, and the log of its runs
// ═══════════════════════════════════════════════════════════════════════
// The refresh used to sit on a 24-hour setInterval with no run at boot.
// A deploy restarts the process, and the timer with it, so on a day with a
// push, or a counselor's configuration save (which also restarts), the
// refresh did not fire, and a week of daily pushes in the summer kept a
// school's new Common Data Set out of College Fit for that week. That is
// the defect scout-cadence.js documents for the scouts. The refresh now
// runs the scouts' way: every run is recorded here, an hourly check (and
// one shortly after boot) compares the last finished run with a one-day
// cadence, a run the previous process left unfinished is due at once, and
// a run that refreshed nothing is retried with the scouts' backoff.

import crypto from "node:crypto";
import { failedStreak, scoutRunDue } from "../scouts/scout-cadence.js";

export const CDS_REFRESH_CADENCE_MS = 24 * 60 * 60 * 1000;
// The boot check waits this long so the refresh never overlaps the boot
// seeding of the Common Data Set store, the heaviest work a boot does
// inside the 512 MB the instance has.
export const CDS_REFRESH_BOOT_DELAY_MS = 15 * 60 * 1000;

export function initCdsRefreshRuns(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cds_refresh_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      trigger TEXT,
      summary_json TEXT
    );
  `);
  // A run row without a finish time at boot belongs to a process that is
  // gone, so it is abandoned, not in progress, and the next check runs the
  // refresh at once.
  try {
    db.prepare(`
      UPDATE cds_refresh_runs
      SET summary_json = json_set(COALESCE(summary_json, '{}'), '$.inProgress', json('false'), '$.abandoned', json('true'))
      WHERE finished_at IS NULL
    `).run();
  } catch { /* JSON1 unavailable: the age threshold still applies */ }
}

export function prepareCdsRefreshStatements(db) {
  return {
    insertRun: db.prepare("INSERT INTO cds_refresh_runs (id, started_at, trigger, summary_json) VALUES (?, ?, ?, ?)"),
    finishRun: db.prepare("UPDATE cds_refresh_runs SET finished_at = ?, summary_json = ? WHERE id = ?"),
    listRuns: db.prepare("SELECT * FROM cds_refresh_runs ORDER BY started_at DESC LIMIT ?"),
  };
}

function parse(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function runOutcome(row, summary) {
  if (summary?.abandoned === true) return "abandoned";
  if (!row.finished_at) return "in_progress";
  return summary?.outcome === "failed" ? "failed" : "completed";
}

export function lastCdsRefreshRun(stmts) {
  const rows = stmts.listRuns.all(25);
  if (!rows.length) return null;
  const outcomes = rows.map((row) => runOutcome(row, parse(row.summary_json)));
  const summary = parse(rows[0].summary_json);
  return {
    id: rows[0].id,
    startedAt: rows[0].started_at,
    finishedAt: rows[0].finished_at,
    trigger: rows[0].trigger,
    outcome: outcomes[0],
    failedStreak: failedStreak(outcomes),
    abandoned: summary?.abandoned === true,
    total: Number(summary?.total) || 0,
    byStatus: summary?.byStatus || {},
    heldBack: Array.isArray(summary?.heldBack) ? summary.heldBack : [],
    error: summary?.error || null,
  };
}

// `inSeason` is shouldRunCdsRefresh(now): new Common Data Sets publish from
// June through December, and outside that window nothing is due (and no
// run is recorded, so June 1 finds the last real run, not an idle one).
export function cdsRefreshDue({ lastRun = null, now = Date.now(), inSeason = true, force = null } = {}) {
  if (!inSeason && !force) return { due: false, reason: "off_season", nextRunAt: null, lastFinishedAt: lastRun?.finishedAt || null };
  return scoutRunDue({ lastRun, cadenceMs: CDS_REFRESH_CADENCE_MS, now, force });
}

// Runs `refresh` (refreshAllCds with its options bound) and records it. A
// refresh that threw, or read an empty repository index, is recorded as
// failed so the next hourly check retries it.
export async function runRecordedCdsRefresh({ stmts, refresh, trigger = "scheduled", now = () => new Date() } = {}) {
  const runId = crypto.randomUUID();
  const startedAt = now().toISOString();
  stmts.insertRun.run(runId, startedAt, trigger, JSON.stringify({ inProgress: true }));
  let result = null;
  let error = null;
  try {
    result = await refresh();
  } catch (err) {
    error = String(err?.message || err || "error").slice(0, 300);
  }
  const total = Number(result?.total) || 0;
  const summary = {
    runId, trigger, startedAt, finishedAt: now().toISOString(),
    outcome: error || total === 0 ? "failed" : "completed",
    total,
    byStatus: result?.byStatus || {},
    heldBack: (result?.heldBack || []).slice(0, 100),
    keptNewer: (result?.keptNewer || []).length,
    error,
  };
  stmts.finishRun.run(summary.finishedAt, JSON.stringify(summary), runId);
  return { ...summary, result };
}
