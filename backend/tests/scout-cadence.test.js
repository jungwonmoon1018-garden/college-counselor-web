import test from "node:test";
import assert from "node:assert/strict";
import { scoutCadenceMs, scoutRunDue, cadenceDays, DEFAULT_SCOUT_CADENCE_DAYS, ABANDONED_RUN_MS } from "../scout-cadence.js";

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
  // Garbage rows never wedge the scout.
  assert.equal(scoutRunDue({ lastRun: { startedAt: "garbage", finishedAt: null }, cadenceMs, now: NOW }).due, true);
});
