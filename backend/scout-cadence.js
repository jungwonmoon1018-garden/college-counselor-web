// ═══════════════════════════════════════════════════════════════════════
// SCOUT CADENCE — when an automatic scout is due
// ═══════════════════════════════════════════════════════════════════════
// The admissions-policy scout and the model-catalog scout used to sit on
// 24-hour setInterval timers. A deploy restarts the process — and the
// timer with it — so on a host that redeploys every few days the interval
// never fired and a boot-time fallback did all the work.
//
// Every automatic scout now runs on one persisted cadence (two weeks by
// default, SCOUT_CADENCE_DAYS overrides): an hourly check compares the
// last completed run recorded in the database with the cadence and runs
// the scout once it has elapsed; the same check runs shortly after boot.
// A counselor's manual run, and a scout-version bump, never wait.

export const DEFAULT_SCOUT_CADENCE_DAYS = 14;
export const SCOUT_DUE_CHECK_MS = 60 * 60 * 1000;
// A run row that never recorded a finish time this long after it started
// was cut short by a restart; it must not block the next run forever.
export const ABANDONED_RUN_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function scoutCadenceMs(env = process.env) {
  const days = Number(env?.SCOUT_CADENCE_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_SCOUT_CADENCE_DAYS) * DAY_MS;
}

// `lastRun` is the newest run row that counts toward the cadence
// ({ startedAt, finishedAt } or null). `force` is a reason string that
// makes the run due regardless (e.g. "manual", "scout_version_changed").
export function scoutRunDue({ lastRun = null, cadenceMs, now = Date.now(), force = null } = {}) {
  const nowMs = typeof now === "number" ? now : new Date(now).getTime();
  const cadence = Number(cadenceMs) > 0 ? Number(cadenceMs) : DEFAULT_SCOUT_CADENCE_DAYS * DAY_MS;
  const lastFinishedAt = lastRun?.finishedAt || null;
  if (force) return { due: true, reason: String(force), nextRunAt: null, lastFinishedAt };
  if (!lastRun) return { due: true, reason: "never_ran", nextRunAt: null, lastFinishedAt: null };
  const finished = Date.parse(lastRun.finishedAt || "");
  if (!Number.isFinite(finished)) {
    const started = Date.parse(lastRun.startedAt || "");
    if (Number.isFinite(started) && nowMs - started < ABANDONED_RUN_MS) {
      return { due: false, reason: "run_in_progress", nextRunAt: null, lastFinishedAt: null };
    }
    return { due: true, reason: "previous_run_abandoned", nextRunAt: null, lastFinishedAt: null };
  }
  const nextRunAt = new Date(finished + cadence).toISOString();
  if (nowMs - finished >= cadence) return { due: true, reason: "cadence_elapsed", nextRunAt, lastFinishedAt };
  return { due: false, reason: "not_due", nextRunAt, lastFinishedAt };
}

export function cadenceDays(cadenceMs) {
  return Math.round((cadenceMs / DAY_MS) * 100) / 100;
}
