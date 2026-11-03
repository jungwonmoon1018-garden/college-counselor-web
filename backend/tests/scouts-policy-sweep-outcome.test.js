// A policy sweep that read none of its schools (outbound fetches failing
// right after a deploy, a DNS outage) used to be recorded as a completed
// run, and the cadence pushed the next sweep a full fortnight out while
// every snapshot went stale. It is now recorded with outcome "failed" and
// retried within the hour, with a doubling backoff.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initFactStore, prepareFactStatements } from "../scouts/fact-store.js";
import {
  initPolicyScout,
  preparePolicyScoutStatements,
  runPolicyScout,
  lastAutomaticRun,
  lastRunSummary,
  policyScoutDue,
  SCOUT_VERSION,
  SWEEP_RULES_VERSION,
} from "../scouts/admissions-policy-scout.js";

const NOW = new Date("2026-11-03T10:05:00Z");
const CADENCE_MS = 14 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const HOMEPAGE = `<html><body>
<h1>Example University</h1>
<p>Welcome to Example University, a residential liberal arts college on the coast of Maine with a long tradition of undergraduate research, close faculty mentorship, and community engagement across every department.</p>
<nav><a href="/admission/first-year">First-Year Admission</a></nav>
</body></html>`;

const FIRST_YEAR = `<html><body>
<h1>First-Year Applicants</h1>
<p>Everything you need to apply to Example University as a first-year student, from the application itself to what we look for and how we read your file with care and context.</p>
<h2>Deadlines</h2>
<table>
<tr><td>Early Decision I</td><td>November 1</td></tr>
<tr><td>Regular Decision</td><td>January 15</td></tr>
</table>
<p>The application fee is $75; fee waivers are available to any student for whom the fee is a hardship.</p>
</body></html>`;

function workingSite() {
  const site = new Map([
    ["https://exampleu.edu/robots.txt", { type: "text/plain", body: "User-agent: *\nDisallow:\n" }],
    ["https://exampleu.edu", { type: "text/html", body: HOMEPAGE }],
    ["https://exampleu.edu/admission/first-year", { type: "text/html", body: FIRST_YEAR }],
  ]);
  return async (url) => {
    const entry = site.get(String(url).replace(/\/+$/, ""));
    if (!entry) return { ok: false, status: 404, url, headers: new Headers(), text: async () => "" };
    return { ok: true, status: 200, url, headers: new Headers({ "content-type": entry.type }), text: async () => entry.body };
  };
}

const offline = async () => { throw new Error("getaddrinfo ENOTFOUND"); };

function stores() {
  const db = new Database(":memory:");
  initFactStore(db);
  initPolicyScout(db);
  return { db, stmts: preparePolicyScoutStatements(db), factStmts: prepareFactStatements(db) };
}

const options = (s, fetchImpl, now) => ({
  stmts: s.stmts, factStmts: s.factStmts, fetchImpl, assertTarget: async () => {}, sleep: async () => {}, now: () => now, trigger: "boot",
});

const TARGETS = [
  { name: "Example University", website: "https://exampleu.edu" },
  { name: "Sample College", website: "https://samplecollege.edu" },
];

test("a sweep that read none of its schools is recorded as failed and retried within the hour", async () => {
  const s = stores();
  const summary = await runPolicyScout(TARGETS, options(s, offline, NOW));
  assert.equal(summary.checked, 0);
  assert.equal(summary.total, 2);
  assert.equal(summary.outcome, "failed");
  const last = lastAutomaticRun(s.stmts);
  assert.equal(last.outcome, "failed");
  assert.equal(last.failedStreak, 1);
  assert.equal(last.scoutVersion, SCOUT_VERSION);
  assert.equal(last.sweepRules, SWEEP_RULES_VERSION);
  assert.equal(lastRunSummary(s.stmts).outcome, "failed", "the counselor's status shows the failure");
  // Not due half an hour later; due an hour later, not a fortnight later.
  const waiting = policyScoutDue(last, { cadenceMs: CADENCE_MS, now: NOW.getTime() + 30 * 60 * 1000 });
  assert.equal(waiting.due, false);
  assert.equal(waiting.reason, "retry_after_failure");
  assert.equal(waiting.nextRunAt, new Date(NOW.getTime() + HOUR).toISOString());
  assert.equal(policyScoutDue(last, { cadenceMs: CADENCE_MS, now: NOW.getTime() + HOUR }).reason, "previous_run_failed");

  // A second failure in a row waits two hours.
  const retryAt = new Date(NOW.getTime() + HOUR);
  await runPolicyScout(TARGETS, { ...options(s, offline, retryAt), trigger: "scheduled" });
  const second = lastAutomaticRun(s.stmts);
  assert.equal(second.failedStreak, 2);
  assert.equal(policyScoutDue(second, { cadenceMs: CADENCE_MS, now: retryAt.getTime() + HOUR }).due, false);
  assert.equal(policyScoutDue(second, { cadenceMs: CADENCE_MS, now: retryAt.getTime() + 2 * HOUR }).due, true);

  // A manual spot-check that fails does not count toward the automatic streak.
  await runPolicyScout(TARGETS.slice(0, 1), { ...options(s, offline, new Date(retryAt.getTime() + 10 * 60 * 1000)), trigger: "manual" });
  assert.equal(lastAutomaticRun(s.stmts).failedStreak, 2);
  assert.equal(lastRunSummary(s.stmts).trigger, "manual");
  s.db.close();
});

test("a sweep that read a school is complete and waits out the cadence; so does one with nothing to read", async () => {
  const s = stores();
  const summary = await runPolicyScout(TARGETS, options(s, workingSite(), NOW));
  assert.equal(summary.checked, 1, JSON.stringify(summary.failures));
  assert.equal(summary.failed + summary.skipped, 1);
  assert.equal(summary.outcome, "completed");
  const last = lastAutomaticRun(s.stmts);
  assert.equal(last.outcome, "completed");
  assert.equal(last.failedStreak, 0);
  assert.equal(policyScoutDue(last, { cadenceMs: CADENCE_MS, now: NOW.getTime() + 2 * HOUR }).reason, "not_due");

  // Every school read within the day is left alone: nothing to read is not a failure.
  const rest = await runPolicyScout(TARGETS.slice(0, 1), { ...options(s, offline, new Date(NOW.getTime() + HOUR)), skipFreshWithinMs: 20 * HOUR });
  assert.equal(rest.total, 0);
  assert.equal(rest.outcome, "completed");
  s.db.close();
});
