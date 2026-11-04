import test from "node:test";
import assert from "node:assert/strict";
import { scoutCadenceMs, scoutRunDue, cadenceDays, DEFAULT_SCOUT_CADENCE_DAYS, ABANDONED_RUN_MS, RETRY_BASE_MS, retryBackoffMs, failedStreak } from "../scouts/scout-cadence.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-05T12:00:00.000Z");

test("the default cadence is two weeks and SCOUT_CADENCE_DAYS overrides it", () => {
  assert.equal(DEFAULT_SCOUT_CADENCE_DAYS, 14);
  assert.equal(scoutCadenceMs({}), 14 * DAY);
  assert.equal(scoutCadenceMs({ SCOUT_CADENCE_DAYS: "3" }), 3 * DAY);
  assert.equal(scoutCadenceMs({ SCOUT_CADENCE_DAYS: "0.5" }), DAY / 2);
  assert.equal(scoutCadenceMs({ SCOUT_CADENCE_DAYS: "0" }), 14 * DAY);
  assert.equal(scoutCadenceMs({ SCOUT_CADENCE_DAYS: "nope" }), 14 * DAY);
  assert.equal(cadenceDays(14 * DAY), 14);
});

test("a scout is due when it never ran, when the cadence elapsed, or when forced", () => {
  const cadenceMs = 14 * DAY;
  assert.deepEqual(scoutRunDue({ lastRun: null, cadenceMs, now: NOW }), { due: true, reason: "never_ran", nextRunAt: null, lastFinishedAt: null });

  const recent = { startedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-01T00:10:00.000Z" };
  const notDue = scoutRunDue({ lastRun: recent, cadenceMs, now: NOW });
  assert.equal(notDue.due, false);
  assert.equal(notDue.reason, "not_due");
  assert.equal(notDue.nextRunAt, "2026-09-15T00:10:00.000Z");
  assert.equal(notDue.lastFinishedAt, recent.finishedAt);

  const old = { startedAt: "2026-08-20T00:00:00.000Z", finishedAt: "2026-08-20T00:10:00.000Z" };
  const due = scoutRunDue({ lastRun: old, cadenceMs, now: NOW });
  assert.equal(due.due, true);
  assert.equal(due.reason, "cadence_elapsed");
  assert.equal(due.nextRunAt, "2026-09-03T00:10:00.000Z");

  // Exactly at the boundary counts as elapsed.
  const boundary = { startedAt: "2026-08-22T11:00:00.000Z", finishedAt: new Date(NOW - cadenceMs).toISOString() };
  assert.equal(scoutRunDue({ lastRun: boundary, cadenceMs, now: NOW }).due, true);

  const forced = scoutRunDue({ lastRun: recent, cadenceMs, now: NOW, force: "manual" });
  assert.equal(forced.due, true);
  assert.equal(forced.reason, "manual");
});

test("an unfinished run blocks only until it is old enough to be abandoned", () => {
  const cadenceMs = 14 * DAY;
  const running = { startedAt: new Date(NOW - 5 * 60 * 1000).toISOString(), finishedAt: null };
  assert.deepEqual(scoutRunDue({ lastRun: running, cadenceMs, now: NOW }), { due: false, reason: "run_in_progress", nextRunAt: null, lastFinishedAt: null });
  const abandoned = { startedAt: new Date(NOW - ABANDONED_RUN_MS - 1000).toISOString(), finishedAt: null };
  assert.equal(scoutRunDue({ lastRun: abandoned, cadenceMs, now: NOW }).reason, "previous_run_abandoned");
  // A run the previous process left unfinished is marked abandoned at boot
  // and is due at once, however young the row is.
  const cutShort = { ...running, abandoned: true };
  assert.deepEqual(scoutRunDue({ lastRun: cutShort, cadenceMs, now: NOW }), { due: true, reason: "previous_run_abandoned", nextRunAt: null, lastFinishedAt: null });
  // Garbage rows never wedge the scout.
  assert.equal(scoutRunDue({ lastRun: { startedAt: "garbage", finishedAt: null }, cadenceMs, now: NOW }).due, true);
});

// A sweep that read none of its schools, or a catalog check with no live
// catalog, finished without doing its work. It used to count as a
// completed run and pushed the next attempt a full cadence out.
test("a failed run is retried after an hour, then with a doubling backoff capped at the cadence", () => {
  const cadenceMs = 14 * DAY;
  const finishedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const failed = { startedAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), finishedAt, outcome: "failed", failedStreak: 1, checked: 0, failed: 300 };
  const due = scoutRunDue({ lastRun: failed, cadenceMs, now: NOW });
  assert.deepEqual(due, { due: true, reason: "previous_run_failed", nextRunAt: new Date(Date.parse(finishedAt) + RETRY_BASE_MS).toISOString(), lastFinishedAt: finishedAt });
  // Thirty minutes after the failure it waits; the retry time is reported.
  const soon = scoutRunDue({ lastRun: { ...failed, finishedAt: new Date(NOW - 30 * 60 * 1000).toISOString() }, cadenceMs, now: NOW });
  assert.equal(soon.due, false);
  assert.equal(soon.reason, "retry_after_failure");
  assert.equal(soon.nextRunAt, new Date(NOW + 30 * 60 * 1000).toISOString());
  // The third failure in a row waits four hours, not one.
  assert.equal(scoutRunDue({ lastRun: { ...failed, failedStreak: 3 }, cadenceMs, now: NOW }).due, false);
  assert.equal(scoutRunDue({ lastRun: { ...failed, failedStreak: 3 }, cadenceMs, now: NOW + 2 * 60 * 60 * 1000 }).due, true);
  // The other direction: a sweep that read 280 of 300 schools is complete
  // and waits out the cadence.
  const completed = { ...failed, outcome: "completed", checked: 280, failed: 20 };
  assert.equal(scoutRunDue({ lastRun: completed, cadenceMs, now: NOW }).reason, "not_due");
  // A row with no outcome (written before outcomes were recorded) reads as complete.
  const legacy = { startedAt: failed.startedAt, finishedAt };
  assert.equal(scoutRunDue({ lastRun: legacy, cadenceMs, now: NOW }).reason, "not_due");
  // Forcing still wins.
  assert.equal(scoutRunDue({ lastRun: { ...failed, finishedAt: new Date(NOW).toISOString() }, cadenceMs, now: NOW, force: "manual" }).reason, "manual");
});

test("the retry backoff doubles from an hour and never exceeds the cadence", () => {
  assert.equal(retryBackoffMs(1, 14 * DAY), RETRY_BASE_MS);
  assert.equal(retryBackoffMs(2, 14 * DAY), 2 * RETRY_BASE_MS);
  assert.equal(retryBackoffMs(5, 14 * DAY), 16 * RETRY_BASE_MS);
  assert.equal(retryBackoffMs(12, 14 * DAY), 14 * DAY);
  assert.equal(retryBackoffMs(500, DAY), DAY);
  assert.equal(retryBackoffMs(undefined, 14 * DAY), RETRY_BASE_MS);
  assert.deepEqual([failedStreak(["failed", "failed", "completed", "failed"]), failedStreak(["completed", "failed"]), failedStreak([])], [2, 0, 0]);
});
