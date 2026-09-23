// ═══════════════════════════════════════════════════════════════════════
// ADMISSIONS POLICY SCOUT — scheduled official-site watch for policy changes
// ═══════════════════════════════════════════════════════════════════════
// Every two weeks (scout-cadence.js; an hourly due check) the scout visits
// each tracked school's OWN
// admissions pages and extracts, deterministically (no model, no key):
//   • standardized-testing policy (test-optional / required / blind / flexible)
//   • first-year plan deadlines (ED, ED II, EA, REA, RD)
//   • the application fee
// It keeps one snapshot per school, logs every field that changed since the
// last visit, and writes the current values into the canonical fact store as
// verified, official-source facts — which is how they reach the chat's
// VERIFIED DATA block and the calendar context.
//
// Guardrails (same family as college-research.js):
//   • Only the school's own site is read. The site comes from the IPEDS
//     baseline row or the College Scorecard, never from model output.
//   • Every fetch passes the SSRF guard; redirects must stay on-site (.edu).
//   • robots.txt is honored; one request per second per host.
//   • Nothing is inferred: a field the pages don't state stays null.

import crypto from "node:crypto";
import { assertSafeFetchTarget } from "../security/safe-fetch.js";
import { expandCollegeAlias, slugifyCollege, currentAdmissionsCycle } from "../colleges/college-research.js";
import { insertFact } from "./fact-store.js";
import { scoutRunDue } from "./scout-cadence.js";
import { policyFields, extractPolicyFromPages, diffPolicies, SCOUT_VERSION, PLAN_LABELS, TEST_POLICY_LABELS } from "./policy-scout-extract.js";
import { hostOf, makeFetcher, resolveSchoolSite, gatherPolicyPages } from "./policy-scout-fetch.js";
export { SCOUT_USER_AGENT, parseRobots, robotsAllows, makeFetcher, resolveSchoolSite, schoolRootHost, schoolDomainToken, rankedPolicyLinks } from "./policy-scout-fetch.js";
export { SCOUT_VERSION, TEST_POLICY_LABELS, PLAN_LABELS, resolveCycleDate, extractTestPolicy, extractDeadlines, extractApplicationFee, extractPolicyFromPages, policyFields, diffPolicies } from "./policy-scout-extract.js";


// ─── Schema ────────────────────────────────────────────────────────────
export function initPolicyScout(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admissions_policy_snapshots (
      slug TEXT PRIMARY KEY,
      school_name TEXT NOT NULL,
      unit_id TEXT,
      homepage TEXT,
      checked_at TEXT NOT NULL,
      changed_at TEXT,
      content_hash TEXT,
      pages_json TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      check_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_policy_snapshots_unit ON admissions_policy_snapshots(unit_id);
    CREATE TABLE IF NOT EXISTS admissions_policy_changes (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      school_name TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      field TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      source_url TEXT,
      severity TEXT NOT NULL DEFAULT 'normal'
    );
    CREATE INDEX IF NOT EXISTS idx_policy_changes_detected ON admissions_policy_changes(detected_at DESC);
    CREATE TABLE IF NOT EXISTS admissions_policy_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      trigger TEXT,
      schools_total INTEGER DEFAULT 0,
      schools_checked INTEGER DEFAULT 0,
      schools_failed INTEGER DEFAULT 0,
      changes INTEGER DEFAULT 0,
      summary_json TEXT
    );
  `);
  // One-time cleanup: scout versions before 3 logged the first population of
  // an empty snapshot as "changes" (previous value null). Drop those rows so
  // the student-facing change list only ever shows real policy changes.
  try {
    db.prepare(`
      DELETE FROM admissions_policy_changes
      WHERE previous_value IS NULL
        AND detected_at <= COALESCE((
          SELECT MAX(COALESCE(finished_at, started_at)) FROM admissions_policy_runs
          WHERE COALESCE(json_extract(summary_json, '$.scoutVersion'), 1) < 3
        ), '')
    `).run();
  } catch { /* JSON1 unavailable — leave the rows */ }
  // A run row without a finish time at boot belongs to a process that is
  // gone — runs live in-process — so it is abandoned, not in progress. The
  // cadence check treats an abandoned run as due at once instead of
  // waiting out the six-hour age threshold meant for a row this process
  // may still be working on.
  try {
    db.prepare(`
      UPDATE admissions_policy_runs
      SET summary_json = json_set(COALESCE(summary_json, '{}'), '$.inProgress', json('false'), '$.abandoned', json('true'))
      WHERE finished_at IS NULL
    `).run();
  } catch { /* JSON1 unavailable — the age threshold still applies */ }
}

export function preparePolicyScoutStatements(db) {
  return {
    upsertSnapshot: db.prepare(`
      INSERT INTO admissions_policy_snapshots (slug, school_name, unit_id, homepage, checked_at, changed_at, content_hash, pages_json, policy_json, check_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(slug) DO UPDATE SET
        school_name = excluded.school_name,
        unit_id = COALESCE(excluded.unit_id, admissions_policy_snapshots.unit_id),
        homepage = excluded.homepage,
        checked_at = excluded.checked_at,
        changed_at = COALESCE(excluded.changed_at, admissions_policy_snapshots.changed_at),
        content_hash = excluded.content_hash,
        pages_json = excluded.pages_json,
        policy_json = excluded.policy_json,
        check_count = admissions_policy_snapshots.check_count + 1`),
    getSnapshot: db.prepare("SELECT * FROM admissions_policy_snapshots WHERE slug = ?"),
    getSnapshotByUnitId: db.prepare("SELECT * FROM admissions_policy_snapshots WHERE unit_id = ? ORDER BY checked_at DESC LIMIT 1"),
    listSnapshots: db.prepare("SELECT * FROM admissions_policy_snapshots ORDER BY school_name ASC LIMIT ?"),
    insertChange: db.prepare(`
      INSERT INTO admissions_policy_changes (id, slug, school_name, detected_at, field, previous_value, new_value, source_url, severity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    listChangesSince: db.prepare("SELECT * FROM admissions_policy_changes WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT ?"),
    insertRun: db.prepare("INSERT INTO admissions_policy_runs (id, started_at, trigger, schools_total, summary_json) VALUES (?, ?, ?, ?, ?)"),
    finishRun: db.prepare("UPDATE admissions_policy_runs SET finished_at = ?, schools_checked = ?, schools_failed = ?, changes = ?, summary_json = ? WHERE id = ?"),
    lastRun: db.prepare("SELECT * FROM admissions_policy_runs ORDER BY started_at DESC LIMIT 1"),
    listRuns: db.prepare("SELECT * FROM admissions_policy_runs ORDER BY started_at DESC LIMIT ?"),
  };
}


// ─── Fact store bridge ─────────────────────────────────────────────────
function cycleExpiry(cycle) {
  // Facts for a cycle expire once that cycle's admissions season is over.
  const endYear = Number(cycle.slice(0, 4)) + 1;
  return `${endYear}-08-01T00:00:00.000Z`;
}

export function writePolicyFacts(factStmts, { slug, schoolName, unitId, policy, checkedAt }) {
  if (!factStmts) return 0;
  let written = 0;
  const cycle = policy.cycle || currentAdmissionsCycle();
  for (const [key, field] of Object.entries(policyFields(policy))) {
    const domain = hostOf(field.sourceUrl);
    if (!domain) continue;
    try {
      insertFact(factStmts, {
        topic_type: "school_policies",
        entity_type: "university",
        entity_id: unitId || slug,
        entity_name: schoolName,
        fact_key: key,
        fact_value: field.value,
        fact_type: field.type,
        source_url: field.sourceUrl,
        source_domain: domain,
        source_title: `${schoolName} official admissions pages`,
        extracted_at: checkedAt,
        verified_at: checkedAt,
        verified_by: "admissions-policy-scout (official site)",
        effective_at: checkedAt,
        expires_at: cycleExpiry(cycle),
        academic_year: cycle,
        provenance_type: "official_site_scout",
        seed_version: "policy_scout_v1",
        confidence: "verified",
      });
      written += 1;
    } catch (err) {
      console.warn(`[policy-scout] fact write failed for ${schoolName}/${key}:`, err.message);
    }
  }
  return written;
}

// ─── Per-school scout ──────────────────────────────────────────────────
// Live single-school read: resolve the site, gather its official admissions
// pages, extract the policy. Nothing is persisted — the daily scout and the
// College Fit double-check both build on this.
export async function readSchoolPolicyLive(target, {
  scorecardKey = null, fetcher = null, fetchImpl = fetch, assertTarget = assertSafeFetchTarget, sleep, now = new Date(),
} = {}) {
  const site = await resolveSchoolSite({ ...target, scorecardKey });
  const slug = slugifyCollege(site.displayName);
  if (!slug) return { site, slug: null, pages: [], policy: null, fetches: 0, failure: "bad_name" };
  if (!site.homepage) return { site, slug, pages: [], policy: null, fetches: 0, failure: "site_unresolved" };
  const { pages, fetches, blocked } = await gatherPolicyPages(site.homepage, fetcher || makeFetcher({ fetchImpl, assertTarget, sleep }));
  if (!pages.length) return { site, slug, pages: [], policy: null, fetches, failure: blocked ? "robots_disallowed" : "no_pages" };
  return { site, slug, pages, policy: extractPolicyFromPages(pages, now), fetches, failure: null };
}

export async function scoutSchool(target, { stmts, factStmts, scorecardKey = null, fetcher, now = new Date() }) {
  const live = await readSchoolPolicyLive(target, { scorecardKey, fetcher, now });
  const { site, slug, pages, policy, fetches } = live;
  if (live.failure === "bad_name") return { school: target.name, status: "skipped", reason: "bad_name" };
  if (live.failure === "site_unresolved") return { school: site.displayName, slug, status: "skipped", reason: "site_unresolved" };
  if (live.failure) return { school: site.displayName, slug, status: "failed", reason: live.failure, fetches };

  const fields = policyFields(policy);
  const previous = stmts.getSnapshot.get(slug);
  const previousPolicy = previous ? safeJson(previous.policy_json) : null;
  // A change is stated-value → different stated value. Filling in a snapshot
  // that held nothing (an earlier failed read, or a weaker scout version) is
  // a first reading, not a policy change.
  const hadFields = previousPolicy && Object.keys(policyFields(previousPolicy)).length > 0;
  const changes = hadFields ? diffPolicies(previousPolicy, policy) : [];
  const checkedAt = now.toISOString();
  const contentHash = crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");

  stmts.upsertSnapshot.run(
    slug, site.displayName, site.unitId || target.unitId || null, site.homepage, checkedAt,
    changes.length ? checkedAt : (previous ? null : checkedAt),
    contentHash,
    JSON.stringify(pages.map((p) => p.url)),
    JSON.stringify(policy),
  );
  for (const change of changes) {
    stmts.insertChange.run(
      crypto.randomUUID(), slug, site.displayName, checkedAt, change.field,
      change.previousValue, change.newValue, change.sourceUrl, change.severity,
    );
  }
  const factsWritten = writePolicyFacts(factStmts, { slug, schoolName: site.displayName, unitId: site.unitId, policy, checkedAt });

  return {
    school: site.displayName,
    slug,
    status: "ok",
    pages: pages.length,
    fetches,
    fieldsFound: Object.keys(fields).length,
    changes,
    factsWritten,
    firstVisit: !previous,
  };
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// ─── The scout run ─────────────────────────────────────────────────────
// A sweep reads every tracked school. It used to stop at sixty, and the
// targets — students' goal schools, every school with a stored Common Data
// Set (about three hundred), the research cache — took a quarter of a year
// to come round. The ceiling only guards against a runaway target list;
// POLICY_SCOUT_MAX_SCHOOLS still sets a lower cap.
export const SWEEP_CEILING = 1000;
// An automatic sweep leaves alone a school read by the running scout
// version within this window: a sweep cut short by a deploy resumes where
// it stopped instead of starting over (three hundred schools take an hour
// or more), and a school a student's question just read is not read twice.
export const SWEEP_FRESH_MS = 20 * 60 * 60 * 1000;
// How long a snapshot's homepage is trusted in place of a new College
// Scorecard search. A school whose stored homepage stops answering keeps
// failing without refreshing its snapshot, so after three cadences the
// sweep resolves its site afresh.
const HOMEPAGE_TRUST_MS = 45 * 24 * 60 * 60 * 1000;

// The rules a sweep is sized by, recorded on each run. SCOUT_VERSION tags
// the readings (a bump re-reads every school and treats every snapshot as
// stale until then); this tags the sweeps, so a change in what a sweep
// covers runs one at the next boot without marking any reading stale.
// 1: sixty schools a sweep. 2: every tracked school.
export const SWEEP_RULES_VERSION = 2;

// Whether an automatic sweep is due: a cadence after the last one, at once
// after a scout version or sweep rules change, or when forced.
export function policyScoutDue(lastRun, { cadenceMs, now = Date.now(), force = null } = {}) {
  const reason = force
    || (lastRun && lastRun.scoutVersion !== SCOUT_VERSION ? "scout_version_changed" : null)
    || (lastRun && lastRun.sweepRules !== SWEEP_RULES_VERSION ? "sweep_rules_changed" : null);
  return scoutRunDue({ lastRun, cadenceMs, now, force: reason });
}

// How a run is sized. A counselor's manual run re-reads everything it names.
export function policyScoutRunLimits(trigger, { maxSchools = null, env = process.env } = {}) {
  const envCap = Number(env?.POLICY_SCOUT_MAX_SCHOOLS);
  const envConcurrency = Number(env?.POLICY_SCOUT_CONCURRENCY);
  return {
    maxSchools: maxSchools || (envCap > 0 ? envCap : SWEEP_CEILING),
    concurrency: envConcurrency > 0 ? envConcurrency : 2,
    skipFreshWithinMs: trigger === "manual" ? 0 : SWEEP_FRESH_MS,
  };
}

export async function runPolicyScout(targets, {
  stmts, factStmts, scorecardKey = null, fetchImpl = fetch, assertTarget = assertSafeFetchTarget,
  concurrency = 2, maxSchools = SWEEP_CEILING, skipFreshWithinMs = 0, trigger = "scheduled", now = () => new Date(), sleep,
} = {}) {
  // Schools with no snapshot first, then those last read by an older scout,
  // then the longest-unread — so a cap never starves a school for good, a
  // version bump reaches the stale readings first, and a resumed sweep
  // reads what the interrupted one had not reached. The sweep that followed
  // the version-4 bump spent its sixty slots on the same schools as always
  // and never got to the Common Data Set schools it was bumped for.
  const nowMs = now().getTime();
  const ranked = dedupeTargets(targets).map((target, index) => {
    let row = null;
    try {
      row = (target.unitId ? stmts.getSnapshotByUnitId.get(String(target.unitId)) : null) || stmts.getSnapshot.get(slugifyCollege(target.name)) || null;
    } catch { row = null; }
    const policy = row ? safeJson(row.policy_json) : null;
    const current = Boolean(row) && policy?.scoutVersion === SCOUT_VERSION;
    const rank = !row ? 0 : current ? 2 : 1;
    const checkedAtMs = Date.parse(row?.checked_at || "");
    const ageMs = Number.isFinite(checkedAtMs) ? nowMs - checkedAtMs : Infinity;
    // A school read before keeps the homepage, name and unit id that read
    // resolved, so the sweep asks the College Scorecard only about schools
    // it has never read. The IPEDS baseline carries few websites, so every
    // tracked school cost one or two Scorecard searches per sweep: sixty
    // were affordable, three hundred would eat into the hourly quota the
    // students' College Fit reads share.
    const known = row?.homepage && !target.website && ageMs < HOMEPAGE_TRUST_MS
      ? { ...target, name: row.school_name || target.name, unitId: target.unitId || row.unit_id || null, website: row.homepage }
      : target;
    const fresh = current && skipFreshWithinMs > 0 && ageMs < skipFreshWithinMs;
    return { target: known, index, rank, fresh, checkedAt: String(row?.checked_at || "") };
  });
  ranked.sort((a, b) => a.rank - b.rank || (a.checkedAt < b.checkedAt ? -1 : a.checkedAt > b.checkedAt ? 1 : 0) || a.index - b.index);
  // Two names for one school (an alias and the name its snapshot carries)
  // are read once.
  const seen = new Set();
  const list = [];
  let recentlyRead = 0;
  for (const entry of ranked) {
    const key = slugifyCollege(expandCollegeAlias(entry.target.name));
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.fresh) { recentlyRead += 1; continue; }
    if (list.length < maxSchools) list.push(entry.target);
  }
  const runId = crypto.randomUUID();
  const startedAt = now().toISOString();
  // The version is recorded up front so an in-progress run reports the
  // scout that is actually running, not the previous run's.
  stmts.insertRun.run(runId, startedAt, trigger, list.length, JSON.stringify({ scoutVersion: SCOUT_VERSION, sweepRules: SWEEP_RULES_VERSION, inProgress: true }));
  const fetcher = makeFetcher({ fetchImpl, assertTarget, sleep });
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const target = list[cursor++];
      try {
        results.push(await scoutSchool(target, { stmts, factStmts, scorecardKey, fetcher, now: now() }));
      } catch (err) {
        results.push({ school: target.name, status: "failed", reason: err?.message || "error" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker));

  const checked = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const changes = results.reduce((sum, r) => sum + (r.changes?.length || 0), 0);
  const summary = {
    runId, trigger, startedAt, finishedAt: now().toISOString(), scoutVersion: SCOUT_VERSION, sweepRules: SWEEP_RULES_VERSION,
    total: list.length, checked, failed, skipped: results.length - checked - failed, recentlyRead, changes,
    changed: results.filter((r) => r.changes?.length).map((r) => ({ school: r.school, changes: r.changes })),
    failures: results.filter((r) => r.status !== "ok").map((r) => ({ school: r.school, reason: r.reason })).slice(0, 40),
  };
  stmts.finishRun.run(summary.finishedAt, checked, failed, changes, JSON.stringify(summary), runId);
  return summary;
}

export function dedupeTargets(targets) {
  const seen = new Set();
  const out = [];
  for (const raw of targets || []) {
    const target = typeof raw === "string" ? { name: raw } : raw;
    const name = expandCollegeAlias(String(target?.name || "").trim());
    if (!name) continue;
    const key = slugifyCollege(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...target, name });
  }
  return out;
}

// ─── Read side ─────────────────────────────────────────────────────────
export function readPolicySnapshot(stmts, { unitId = null, name = null } = {}) {
  let row = null;
  if (unitId) row = stmts.getSnapshotByUnitId.get(String(unitId)) || null;
  if (!row && name) row = stmts.getSnapshot.get(slugifyCollege(expandCollegeAlias(name))) || null;
  if (!row) return null;
  const policy = safeJson(row.policy_json);
  if (!policy) return null;
  return {
    slug: row.slug,
    school: row.school_name,
    unitId: row.unit_id,
    checkedAt: row.checked_at,
    changedAt: row.changed_at,
    policy,
    fields: policyFields(policy),
  };
}

// A snapshot read by the scout version now running. One from an older
// version (or from before versions were recorded) still answers, but the
// school's pages are read again on demand the next time it is asked about:
// Johns Hopkins kept a version-3 reading with no ED II date for a day
// after the table fix shipped because the sweep never reached it.
export function snapshotIsCurrent(snapshot) {
  return snapshot?.policy?.scoutVersion === SCOUT_VERSION;
}

// The calendar context and the deterministic deadline answer read the
// research cache's record shape; a scouted snapshot can stand in for it.
export function snapshotAsDeadlineRecord(snapshot) {
  const deadlines = snapshot?.policy?.deadlines || {};
  const pick = (...keys) => keys.map((k) => deadlines[k]?.date).find(Boolean) || null;
  const record = {
    displayName: snapshot.school,
    slug: snapshot.slug,
    cycle: snapshot.policy?.cycle || currentAdmissionsCycle(),
    deadlines: {
      ea: pick("early_action", "restrictive_early_action"),
      ed: pick("early_decision"),
      // The scout has read ED II ("Early Decision II", "ED2") from pages all
      // along; the record shape simply had no slot for it, so Hopkins'
      // second round never reached the calendar or the deadline answer.
      edII: pick("early_decision_2"),
      rd: pick("regular_decision"),
      financialAid: null,
      commitBy: null,
      decisionRelease: null,
    },
    // Stanford-style plans: the "ea" slot holds Restrictive Early Action.
    labels: {
      ...(deadlines.early_action?.date ? {} : deadlines.restrictive_early_action?.date ? { ea: PLAN_LABELS.restrictive_early_action } : {}),
      ...(deadlines.regular_decision?.evidence && /regular action/i.test(deadlines.regular_decision.evidence) ? { rd: "Regular Action" } : {}),
    },
    sourceUrl: Object.values(deadlines).map((d) => d?.sourceUrl).find(Boolean) || null,
    extractedAt: snapshot.checkedAt,
    source: "admissions_policy_scout",
  };
  // A second Early Decision round opens after the first round's decisions
  // are out — a month or more after ED I, never a fortnight. Header-row
  // tables (plans across the top, dates beneath) can pair the "Early
  // Decision II" heading with a date from a neighbouring column or row:
  // Johns Hopkins' page yielded November 15 for ED II when its ED II
  // deadline is January 2. Such a date is dropped rather than turned into a
  // reminder; the ED I and RD dates on the same page stand.
  if (record.deadlines.edII && record.deadlines.ed) {
    const gapDays = (Date.parse(record.deadlines.edII) - Date.parse(record.deadlines.ed)) / 86_400_000;
    if (!Number.isFinite(gapDays) || gapDays < 30) record.deadlines.edII = null;
  }
  return Object.values(record.deadlines).some(Boolean) ? record : null;
}

export function formatPolicyLine(snapshot) {
  if (!snapshot?.policy) return null;
  const parts = [];
  const tp = snapshot.policy.testPolicy;
  if (tp?.value) parts.push(`test policy — ${TEST_POLICY_LABELS[tp.value] || tp.value}${tp.through ? ` (through ${tp.through})` : ""}`);
  for (const plan of Object.keys(PLAN_LABELS)) {
    const entry = snapshot.policy.deadlines?.[plan];
    if (entry?.date) parts.push(`${PLAN_LABELS[plan]} deadline ${entry.date}`);
  }
  const fee = snapshot.policy.applicationFee;
  if (fee && Number.isFinite(fee.amount)) parts.push(`application fee ${fee.amount === 0 ? "none" : `${fee.amount} USD`}`);
  if (!parts.length) return null;
  const sources = [...new Set([tp?.sourceUrl, ...Object.values(snapshot.policy.deadlines || {}).map((d) => d?.sourceUrl), fee?.sourceUrl].filter(Boolean))];
  const checked = String(snapshot.checkedAt || "").slice(0, 10);
  return `Admissions policy (official site, checked ${checked}): ${parts.join("; ")} [Source: ${sources.slice(0, 2).join(" ; ") || "official admissions pages"}]`;
}

export function listRecentChanges(stmts, { days = 30, limit = 100 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return stmts.listChangesSince.all(since, limit).map((row) => ({
    id: row.id,
    school: row.school_name,
    slug: row.slug,
    detectedAt: row.detected_at,
    field: row.field,
    label: row.field === "test_policy" ? "Testing policy"
      : row.field === "application_fee" ? "Application fee"
        : `${PLAN_LABELS[row.field.replace(/^deadline_/, "")] || row.field} deadline`,
    previousValue: row.previous_value,
    newValue: row.new_value,
    sourceUrl: row.source_url,
    severity: row.severity,
  }));
}

export function lastRunSummary(stmts) {
  const row = stmts.lastRun.get();
  return row ? summarizeRun(row) : null;
}

// The newest run that counts toward the automatic cadence: a boot or
// scheduled sweep. A counselor's manual spot-check of a few schools must not
// push the next full sweep out by another cadence.
export function lastAutomaticRun(stmts) {
  const row = stmts.listRuns.all(25).find((r) => r.trigger !== "manual");
  return row ? summarizeRun(row) : null;
}

function summarizeRun(row) {
  const summary = safeJson(row.summary_json);
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    trigger: row.trigger,
    scoutVersion: summary?.scoutVersion ?? 1,
    sweepRules: Number(summary?.sweepRules) || 1,
    abandoned: summary?.abandoned === true,
    schoolsTotal: row.schools_total,
    recentlyRead: Number(summary?.recentlyRead) || 0,
    schoolsChecked: row.schools_checked,
    schoolsFailed: row.schools_failed,
    changes: row.changes,
  };
}
