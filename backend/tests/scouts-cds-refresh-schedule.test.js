// The June-December daily Common Data Set refresh used to be a bare 24-hour
// setInterval with no run at boot, so any restart within a day (a deploy,
// a counselor's configuration save) reset it and on busy weeks it never
// fired. It now runs the scouts' way: recorded runs, an hourly check
// against the last finished one, abandoned runs due at once, failed ones
// retried with a backoff.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  CDS_REFRESH_BOOT_DELAY_MS,
  CDS_REFRESH_CADENCE_MS,
  cdsRefreshDue,
  initCdsRefreshRuns,
  lastCdsRefreshRun,
  prepareCdsRefreshStatements,
  runRecordedCdsRefresh,
} from "../cds/cds-refresh-schedule.js";
import { readServerSource } from "./helpers/server-source.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-08-20T12:00:00.000Z");

function store() {
  const db = new Database(":memory:");
  initCdsRefreshRuns(db);
  return { db, stmts: prepareCdsRefreshStatements(db) };
}

test("the refresh is due a day after its last finished run, whatever the process's age", () => {
  const finished = (hoursAgo) => ({ startedAt: new Date(NOW - hoursAgo * HOUR - 600_000).toISOString(), finishedAt: new Date(NOW - hoursAgo * HOUR).toISOString(), outcome: "completed" });
  assert.equal(CDS_REFRESH_CADENCE_MS, 24 * HOUR);
  assert.equal(cdsRefreshDue({ lastRun: finished(30), now: NOW }).reason, "cadence_elapsed");
  assert.equal(cdsRefreshDue({ lastRun: finished(2), now: NOW }).reason, "not_due");
  assert.equal(cdsRefreshDue({ lastRun: finished(2), now: NOW }).nextRunAt, new Date(NOW + 22 * HOUR).toISOString());
  assert.equal(cdsRefreshDue({ lastRun: null, now: NOW }).reason, "never_ran");
  // Off season nothing is due, however old the last run.
  assert.deepEqual(cdsRefreshDue({ lastRun: finished(30), now: NOW, inSeason: false }), { due: false, reason: "off_season", nextRunAt: null, lastFinishedAt: finished(30).finishedAt });
  // A failed run is retried after an hour, not a day.
  const failed = { ...finished(2), outcome: "failed", failedStreak: 1 };
  assert.equal(cdsRefreshDue({ lastRun: failed, now: NOW }).reason, "previous_run_failed");
  assert.equal(cdsRefreshDue({ lastRun: { ...failed, failedStreak: 3 }, now: NOW }).reason, "retry_after_failure");
  // The boot check waits past the boot seeding of the CDS store.
  assert.ok(CDS_REFRESH_BOOT_DELAY_MS >= 10 * 60 * 1000);
});

test("runs are recorded; one the previous process left unfinished is due at once at the next boot", async () => {
  const { db, stmts } = store();
  const ok = await runRecordedCdsRefresh({
    stmts,
    trigger: "scheduled",
    refresh: async () => ({ total: 310, byStatus: { ok: 300, held_back: 1, cached: 9 }, heldBack: [{ slug: "example-u", year: "2026-27", storedYear: "2025-26", reasons: ["admit rate moved 30 points"] }], keptNewer: [] }),
    now: () => new Date(NOW - 3 * HOUR),
  });
  assert.equal(ok.outcome, "completed");
  let last = lastCdsRefreshRun(stmts);
  assert.equal(last.outcome, "completed");
  assert.equal(last.total, 310);
  assert.equal(last.heldBack[0].slug, "example-u");
  assert.equal(cdsRefreshDue({ lastRun: last, now: NOW }).due, false);

  // A deploy cuts the next run short: the row has no finish time.
  stmts.insertRun.run("run-cut", new Date(NOW - HOUR).toISOString(), "scheduled", JSON.stringify({ inProgress: true }));
  assert.equal(cdsRefreshDue({ lastRun: lastCdsRefreshRun(stmts), now: NOW }).reason, "run_in_progress");
  initCdsRefreshRuns(db); // the next boot
  last = lastCdsRefreshRun(stmts);
  assert.equal(last.abandoned, true);
  assert.equal(cdsRefreshDue({ lastRun: last, now: NOW }).reason, "previous_run_abandoned");
  db.close();
});

test("a refresh that threw or read an empty index is recorded as failed and retried with a backoff", async () => {
  const { db, stmts } = store();
  const threw = await runRecordedCdsRefresh({ stmts, refresh: async () => { throw new Error("repository index fetch failed"); }, now: () => new Date(NOW - 2 * HOUR) });
  assert.equal(threw.outcome, "failed");
  assert.equal(threw.error, "repository index fetch failed");
  const empty = await runRecordedCdsRefresh({ stmts, refresh: async () => ({ total: 0, byStatus: {}, heldBack: [] }), now: () => new Date(NOW - HOUR) });
  assert.equal(empty.outcome, "failed");
  const last = lastCdsRefreshRun(stmts);
  assert.equal(last.failedStreak, 2);
  assert.equal(cdsRefreshDue({ lastRun: last, now: NOW }).due, false, "the second failure in a row waits two hours");
  assert.equal(cdsRefreshDue({ lastRun: last, now: NOW + HOUR }).due, true);
  db.close();
});

test("the daily CDS refresh is checked hourly against its last run, not left on a bare 24-hour timer", () => {
  const SERVER = readServerSource();
  assert.match(SERVER, /registerJob\("cds_daily_refresh", \(\) => maybeRunCdsRefresh\("scheduled"\), SCOUT_DUE_CHECK_MS, \{ enabled: true, runOnStartup: false \}\)/);
  assert.doesNotMatch(SERVER, /registerJob\("cds_daily_refresh"[\s\S]{0,2500}?\}, 24 \* 60 \* 60 \* 1000, \{ enabled: true, runOnStartup: false \}\)/);
  assert.match(SERVER, /maybeRunCdsRefresh\("boot"\)/);
  assert.match(SERVER, /cdsRefreshDue\(\{ lastRun: lastCdsRefreshRun\(cdsRefreshStmts\), inSeason: shouldRunCdsRefresh\(Date\.now\(\)\) \}\)/);
});
