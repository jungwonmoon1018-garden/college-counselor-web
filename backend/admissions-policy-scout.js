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
import { assertSafeFetchTarget } from "./cds-ingest-pipeline.js";
import { searchScorecard } from "./college-scorecard.js";
import {
  htmlToText, sameSite, pickScorecardHit, expandCollegeAlias,
  slugifyCollege, currentAdmissionsCycle,
} from "./college-research.js";
import { insertFact } from "./fact-store.js";

export const SCOUT_USER_AGENT = "CollegeCounselorBot/1.0 (educational; admissions-policy watch)";
// Bumped whenever discovery or extraction changes; a boot after a bump
// re-scouts immediately instead of waiting for the next cadence.
export const SCOUT_VERSION = 3;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 700_000;
const MAX_PAGE_TEXT_CHARS = 20_000;
const MAX_FETCHES_PER_SCHOOL = 12;
const MAX_PAGES_PER_SCHOOL = 7;
const PER_HOST_DELAY_MS = 1_000;

const PROBE_PATHS = [
  "/admission", "/admissions", "/apply",
  "/admission/first-year", "/admissions/first-year", "/apply/first-year", "/apply/firstyear",
  "/admission/deadlines", "/admissions/deadlines", "/apply/deadlines",
  "/admission/testing", "/admissions/testing", "/apply/first-year/testing",
  "/admission/standardized-testing", "/admissions/standardized-testing",
];

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

// ─── Pure extraction ───────────────────────────────────────────────────
export const TEST_POLICY_LABELS = Object.freeze({
  test_optional: "test-optional",
  test_required: "test scores required",
  test_blind: "test-blind (scores not considered)",
  test_flexible: "test-flexible",
});

export const PLAN_LABELS = Object.freeze({
  restrictive_early_action: "Restrictive Early Action",
  early_decision: "Early Decision",
  early_decision_2: "Early Decision II",
  early_action: "Early Action",
  regular_decision: "Regular Decision",
});

const TEST_CONTEXT_RE = /\b(?:SAT|ACT|standardized test(?:ing| scores?)?|test scores?|test[- ]?optional|test[- ]?blind|test[- ]?free|test[- ]?flexible|testing (?:policy|requirement))\b/i;
const TEST_POLICY_RULES = [
  ["test_blind", /\btest[- ]?(?:blind|free)\b|\bwill not (?:consider|review|use|look at) (?:the )?(?:SAT|ACT|standardized test|test scores)|\b(?:do|does) not consider (?:the )?(?:SAT|ACT|standardized test|test scores)/i],
  ["test_flexible", /\btest[- ]?flexible\b/i],
  ["test_required", /\b(?:SAT|ACT|standardized test(?:ing| scores)?|test scores?)\b[^.;\n]{0,40}?\b(?:are|is|will be|remain|remains|become|becomes)\s+required\b|\brequire(?:s|d)?\s+(?:the |an? |official )?(?:SAT|ACT|standardized test|test scores)|\bmust submit (?:the |an? |official )?(?:SAT|ACT|(?:standardized )?test scores)|\breinstat(?:e|es|ed|ing) (?:the |its |our |a )?(?:SAT|ACT|standardized test|testing) requirement/i],
  ["test_optional", /\btest[- ]?optional\b|\b(?:SAT|ACT|test scores?)\b[^.;\n]{0,40}?\b(?:are|is|remain|remains)\s+(?:not required|optional)\b|\b(?:not|no longer) required to submit (?:the |an? )?(?:SAT|ACT|test scores)|\b(?:may|can) (?:choose|elect|opt|decide) (?:whether (?:or not )?)?to submit/i],
];
const NOT_REQUIRED_NEGATION_RE = /\b(?:not|no longer|aren't|isn't|are not|is not|never)\s+(?:be\s+)?required\b|\boptional\b/i;

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const DATE_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d\d))?\b|\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\b/g;

// Long names match case-insensitively; the abbreviations must be upper-case
// ("ed" and "rd" are ordinary words). Order matters: REA before EA, ED II
// before ED.
const PLAN_RULES = [
  ["restrictive_early_action", [/\b(?:restrictive|single[- ]choice) early action\b/i, /\bREA\b|\bSCEA\b/]],
  ["early_decision_2", [/\bearly decision (?:II|2)\b/i, /\bED ?(?:II|2)\b/]],
  ["early_decision", [/\bearly decision(?: I| 1)?\b(?! ?(?:II|2))/i, /\bED ?(?:I|1)?\b(?! ?(?:II|2))/]],
  ["early_action", [/\bearly action\b(?! ?(?:II|2))/i, /\bEA\b/]],
  // MIT calls its regular round "Regular Action (RA)".
  ["regular_decision", [/\bregular (?:decision|action)\b/i, /\bRD\b/, /\bRA\s+(?:deadline|application|applicants|cycle|round)/i]],
];

function splitSentences(text) {
  return String(text || "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function pad(n) { return String(n).padStart(2, "0"); }

// Turn a month/day (optionally with a year) into the ISO date for the
// admissions cycle in progress: Aug–Dec dates belong to the cycle's first
// calendar year, Jan–Jul to its second.
export function resolveCycleDate(month, day, year, now = new Date()) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const cycle = currentAdmissionsCycle(now);
  const startYear = Number(cycle.slice(0, 4));
  const resolvedYear = year || (month >= 8 ? startYear : startYear + 1);
  const iso = `${resolvedYear}-${pad(month)}-${pad(day)}`;
  const ts = Date.parse(iso + "T00:00:00Z");
  if (!Number.isFinite(ts)) return null;
  const min = now.getTime() - 150 * 24 * 60 * 60 * 1000;
  const max = now.getTime() + 560 * 24 * 60 * 60 * 1000;
  return ts >= min && ts <= max ? iso : null;
}

function datesIn(text, now) {
  const out = [];
  DATE_RE.lastIndex = 0;
  let m;
  while ((m = DATE_RE.exec(text))) {
    const month = m[1] ? MONTHS[m[1].toLowerCase()] : Number(m[4]);
    const day = m[1] ? Number(m[2]) : Number(m[5]);
    const year = m[1] ? (m[3] ? Number(m[3]) : null) : Number(m[6]);
    const iso = resolveCycleDate(month, day, year, now);
    if (iso) out.push({ iso, index: m.index });
  }
  return out;
}

function trimEvidence(sentence) {
  const s = String(sentence || "").replace(/\s+/g, " ").trim();
  return s.length > 240 ? `${s.slice(0, 237)}…` : s;
}

function yearsMentioned(sentence) {
  return [...String(sentence).matchAll(/\b(20\d\d)\b/g)].map((m) => Number(m[1]));
}

export function extractTestPolicy(pages, now = new Date()) {
  const cycle = currentAdmissionsCycle(now);
  const entryYear = Number(cycle.slice(0, 4)) + 1;
  let best = null;
  for (const page of pages) {
    for (const sentence of splitSentences(page.text)) {
      if (sentence.length > 600 || !TEST_CONTEXT_RE.test(sentence)) continue;
      let policy = null;
      for (const [name, re] of TEST_POLICY_RULES) {
        if (!re.test(sentence)) continue;
        // "SAT scores are not required" must not read as test_required.
        if (name === "test_required" && NOT_REQUIRED_NEGATION_RE.test(sentence)) continue;
        policy = name;
        break;
      }
      if (!policy) continue;
      const years = yearsMentioned(sentence);
      let score = 1;
      if (years.includes(entryYear)) score += 3;
      else if (years.length && !years.some((y) => y >= entryYear - 1)) score -= 2; // only past cycles mentioned
      if (/\bfirst[- ]year|freshman|first-time/i.test(sentence)) score += 1;
      if (/\btest[- ]?(?:optional|blind|free|flexible)\b|\brequired\b/i.test(sentence)) score += 1;
      if (!best || score > best.score) {
        const through = sentence.match(/\b(?:through|until|for)\s+(?:the\s+)?(?:fall\s+|the\s+)?(?:(20\d\d)(?:[-–](\d\d))?|(?:entering\s+)?class(?:es)?\s+of\s+(20\d\d))/i);
        best = {
          score,
          value: policy,
          through: through ? (through[3] ? `Class of ${through[3]}` : `${through[1]}${through[2] ? `-${through[2]}` : ""}`) : null,
          evidence: trimEvidence(sentence),
          sourceUrl: page.url,
        };
      }
    }
  }
  if (!best) return null;
  const { score: _score, ...policy } = best;
  return policy;
}

// A line that states the plan's deadline outright ("Restrictive Early
// Action: November 1", "Early Decision deadline: Nov 1") outranks a hedged
// note that happens to name the plan and a date ("if you intend to submit
// an REA application with an arts portfolio, submit by October 15").
const DEADLINE_HINT_RE = /\bdeadlines?\b|\bdue\b|must be (?:submitted|received)|submit(?:ted)? by|application date|apply by/i;
const DEADLINE_HEDGE_RE = /portfolio|arts? supplement|audition|financial aid|css profile|fafsa|scholarship|priority|housing|deposit|interview|recommendation|transcript|mid-?year|if you (?:intend|plan|choose|wish)|optional/i;
const DEADLINE_STANDARD_RE = /\bstandard\b|\bwithout\b|\bregular applicants\b/i;

function scoreDeadlineLine(sentence) {
  let score = 0;
  if (DEADLINE_HINT_RE.test(sentence)) score += 3;
  if (DEADLINE_HEDGE_RE.test(sentence)) score -= 4;
  if (sentence.length < 120) score += 1; // table rows read as short lines
  return score;
}

const SECTION_LINES = 14; // how far below a plan header its dates may sit
const HEADER_MAX_CHARS = 60;

function planOnLine(sentence) {
  for (const [plan, rules] of PLAN_RULES) {
    const m = rules.map((re) => re.exec(sentence)).find(Boolean);
    if (m) return { plan, index: m.index };
  }
  return null;
}

// Two layouts occur on real pages:
//   • same line — "Early Decision: November 1" / "November 1 — Early Decision";
//   • section — the plan name is a heading and the dates follow on later
//     lines, often under sub-headings ("With Arts Portfolio" / "Standard").
// Every candidate is scored so a plain deadline statement beats a hedged
// note, and a "standard" line beats a portfolio/supplement variant.
export function extractDeadlines(pages, now = new Date()) {
  const best = {};
  const consider = (plan, score, date, sentence, page) => {
    if (!best[plan] || score > best[plan].score) {
      best[plan] = { score, date, evidence: trimEvidence(sentence), sourceUrl: page.url };
    }
  };
  for (const page of pages) {
    const lines = String(page.text || "").split(/\n+/).map((l) => l.trim());
    let section = null; // { plan, line, hedged }
    for (let i = 0; i < lines.length; i += 1) {
      const sentence = lines[i];
      if (!sentence || sentence.length > 400) continue;
      const dates = datesIn(sentence, now);
      const planHere = planOnLine(sentence);

      if (!dates.length) {
        const isHeader = sentence.length <= HEADER_MAX_CHARS;
        if (planHere && isHeader) section = { plan: planHere.plan, line: i, hedged: false };
        else if (section && isHeader && DEADLINE_HEDGE_RE.test(sentence)) section.hedged = true;
        else if (section && isHeader && DEADLINE_STANDARD_RE.test(sentence)) section.hedged = false;
        continue;
      }

      if (planHere) {
        // Prefer the first date after the plan name; fall back to the
        // nearest date before it ("November 1 — Early Decision").
        const after = dates.find((d) => d.index > planHere.index && d.index - planHere.index <= 120);
        const before = [...dates].reverse().find((d) => d.index < planHere.index && planHere.index - d.index <= 60);
        const pick = after || before;
        if (pick) consider(planHere.plan, scoreDeadlineLine(sentence) + 2, pick.iso, sentence, page);
        continue;
      }

      if (section && i - section.line <= SECTION_LINES) {
        // A dated sub-block header ("Application with Optional Arts
        // Portfolio - October 15") hedges the lines that follow it until a
        // "Standard …" line opens the plain block.
        if (DEADLINE_HEDGE_RE.test(sentence)) section.hedged = true;
        else if (DEADLINE_STANDARD_RE.test(sentence)) section.hedged = false;
        let score = scoreDeadlineLine(sentence);
        if (section.hedged) score -= 4;
        if (/\bstandard\b/i.test(sentence)) score += 2;
        if (/common app(?:lication)?|coalition|application deadline|application due/i.test(sentence)) score += 1;
        consider(section.plan, score, dates[0].iso, `${PLAN_LABELS[section.plan]} — ${sentence}`, page);
      }
    }
  }
  const found = {};
  for (const [plan, entry] of Object.entries(best)) {
    const { score: _score, ...rest } = entry;
    found[plan] = rest;
  }
  return found;
}

export function extractApplicationFee(pages) {
  for (const page of pages) {
    for (const sentence of splitSentences(page.text)) {
      if (!/\bapplication fee\b|\bfee to apply\b|\bfree to apply\b/i.test(sentence) || sentence.length > 400) continue;
      if (/\bno application fee\b|\bfree to apply\b|\bapplication fee\b[^.;\n]{0,30}?\bwaived for all\b/i.test(sentence)) {
        return { amount: 0, evidence: trimEvidence(sentence), sourceUrl: page.url };
      }
      const m = sentence.match(/\bapplication fee\b[^.;\n]{0,60}?\$\s?(\d{2,3})\b/i) || sentence.match(/\$\s?(\d{2,3})\b[^.;\n]{0,40}?\bapplication fee\b/i);
      if (m) return { amount: Number(m[1]), evidence: trimEvidence(sentence), sourceUrl: page.url };
    }
  }
  return null;
}

export function extractPolicyFromPages(pages, now = new Date()) {
  return {
    cycle: currentAdmissionsCycle(now),
    testPolicy: extractTestPolicy(pages, now),
    deadlines: extractDeadlines(pages, now),
    applicationFee: extractApplicationFee(pages),
  };
}

// Flatten a policy into comparable field → value pairs (what the change log
// and the fact store see).
export function policyFields(policy) {
  const fields = {};
  if (policy?.testPolicy?.value) {
    fields.test_policy = {
      value: `${TEST_POLICY_LABELS[policy.testPolicy.value] || policy.testPolicy.value}${policy.testPolicy.through ? ` (through ${policy.testPolicy.through})` : ""}`,
      sourceUrl: policy.testPolicy.sourceUrl,
      severity: "high",
      type: "text",
    };
  }
  for (const [plan, entry] of Object.entries(policy?.deadlines || {})) {
    if (!entry?.date) continue;
    fields[`deadline_${plan}`] = { value: entry.date, sourceUrl: entry.sourceUrl, severity: "high", type: "date" };
  }
  if (policy?.applicationFee && Number.isFinite(policy.applicationFee.amount)) {
    fields.application_fee = {
      value: policy.applicationFee.amount === 0 ? "no fee" : `${policy.applicationFee.amount} USD`,
      sourceUrl: policy.applicationFee.sourceUrl,
      severity: "normal",
      type: "text",
    };
  }
  return fields;
}

export function diffPolicies(previous, next) {
  const before = policyFields(previous);
  const after = policyFields(next);
  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key]?.value ?? null;
    const b = after[key]?.value ?? null;
    if (a === b) continue;
    // A field that merely dropped out of the fetched pages is not a policy
    // change — pages get restructured; only a stated → different stated
    // value counts.
    if (a != null && b == null) continue;
    changes.push({
      field: key,
      previousValue: a,
      newValue: b,
      sourceUrl: after[key]?.sourceUrl || before[key]?.sourceUrl || null,
      severity: after[key]?.severity || "normal",
    });
  }
  return changes;
}

// ─── robots.txt ────────────────────────────────────────────────────────
export function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      // Consecutive User-agent lines share one group; a User-agent after
      // rules starts a new group.
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === "disallow" || key === "allow") && current) {
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return groups;
}

function robotsPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped.endsWith("$") ? escaped.slice(0, -1) + "$" : escaped}`);
}

export function robotsAllows(groups, pathname, agent = "collegecounselorbot") {
  const wanted = agent.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a === wanted || (a !== "*" && wanted.includes(a))))
    || groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let verdict = true;
  let longest = -1;
  for (const rule of group.rules) {
    if (!rule.path) continue; // "Disallow:" (empty) allows everything
    if (!robotsPatternToRegExp(rule.path).test(pathname)) continue;
    if (rule.path.length > longest) { longest = rule.path.length; verdict = rule.allow; }
  }
  return verdict;
}

// ─── Guarded fetching ──────────────────────────────────────────────────
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

export function makeFetcher({ fetchImpl = fetch, assertTarget = assertSafeFetchTarget, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const lastHit = new Map();
  const robotsCache = new Map();

  async function throttle(url) {
    const host = hostOf(url);
    const wait = (lastHit.get(host) || 0) + PER_HOST_DELAY_MS - now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, now());
  }

  // The timeout covers the whole exchange, body included — clearing it once
  // the headers arrive would let a slow body hang a run indefinitely.
  const debug = process.env.POLICY_SCOUT_DEBUG === "1";
  async function rawGet(url, accept, readBody) {
    const started = Date.now();
    await assertTarget(url);
    await throttle(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": SCOUT_USER_AGENT, "Accept": accept },
        redirect: "follow",
      });
      const result = await readBody(response);
      if (debug) console.log(`[policy-scout] GET ${url} → ${response.status} ${response.url && response.url !== url ? `(→ ${response.url}) ` : ""}${Date.now() - started}ms${result ? "" : " (discarded)"}`);
      return result;
    } catch (err) {
      if (debug) console.log(`[policy-scout] GET ${url} failed after ${Date.now() - started}ms: ${err?.name || err?.message}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function allowed(url) {
    let origin;
    try { origin = new URL(url).origin; } catch { return false; }
    if (!robotsCache.has(origin)) {
      let groups = [];
      try {
        groups = await rawGet(`${origin}/robots.txt`, "text/plain", async (response) => (
          response.ok ? parseRobots((await response.text()).slice(0, 200_000)) : []
        ));
      } catch { groups = []; }
      robotsCache.set(origin, groups);
    }
    return robotsAllows(robotsCache.get(origin), new URL(url).pathname);
  }

  async function page(url, { acceptFinalUrl = null } = {}) {
    try {
      if (!(await allowed(url))) return { url, blocked: "robots" };
      return await rawGet(url, "text/html,application/xhtml+xml,text/plain;q=0.8", async (response) => {
        if (!response.ok) return null;
        const finalUrl = response.url || url;
        // Redirects must land on the school's site — or on a host the
        // caller vouches for (its off-site admissions domain).
        if (!sameSite(finalUrl, url) && !hostOf(finalUrl).endsWith(".edu") && !(acceptFinalUrl && acceptFinalUrl(finalUrl))) return null;
        // Soft 404s: a 200 that redirected to the site's error page.
        if (/404|not-?found|\/errors?\//i.test(pathAndQuery(finalUrl))) return null;
        const contentType = String(response.headers?.get?.("content-type") || "");
        if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) return null;
        const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
        const text = htmlToText(html).slice(0, MAX_PAGE_TEXT_CHARS);
        if (!text || text.length < 120) return null;
        return { url: finalUrl, html, text };
      });
    } catch {
      return null;
    }
  }

  return { page };
}

// ─── Official site resolution ──────────────────────────────────────────
function normalizeHomepage(url) {
  const value = String(url || "").trim();
  if (!value) return null;
  const withProto = /^https?:\/\//i.test(value) ? value : "https://" + value;
  try { return new URL(withProto).origin + "/"; } catch { return null; }
}

export async function resolveSchoolSite({ name, unitId = null, website = null, scorecardKey = null }) {
  let displayName = expandCollegeAlias(String(name || "").trim());
  let homepage = normalizeHomepage(website);
  let resolvedUnitId = unitId ? String(unitId) : null;
  if (!homepage && scorecardKey) {
    try {
      let search = await searchScorecard(scorecardKey, { name: displayName, limit: 20 });
      let hit = pickScorecardHit(search?.results, displayName);
      if (!hit) {
        search = await searchScorecard(scorecardKey, { name: displayName, limit: 20, anyLevel: true });
        hit = pickScorecardHit(search?.results, displayName);
      }
      if (hit) {
        homepage = normalizeHomepage(hit.website);
        displayName = hit.name || displayName;
        resolvedUnitId = resolvedUnitId || (hit.unitId ?? hit.id ? String(hit.unitId ?? hit.id) : null);
      }
    } catch { /* unresolved → skipped below */ }
  }
  return { displayName, homepage, unitId: resolvedUnitId };
}

// ─── Page discovery ────────────────────────────────────────────────────
// Links are ranked by how specifically their PATH or anchor text points at
// policy content. Matching the whole URL would score every link on
// admission.<school>.edu equally (the hostname itself matches "admission"),
// which let a landing page's nav crowd out the deadlines and testing pages.
// Word-bounded on purpose: "Updates" must not count as "dates", and
// "Admission Volunteers" is not a policy page.
const LINK_SCORES = [
  [/\bdeadlines?\b|\bdates\b|dates-and-deadlines/i, 5],
  [/\btesting\b|\btests?\b|test-optional|test-policy|standardized|test-scores|tests-scores/i, 5],
  [/first-year|firstyear|\bfreshman\b|first-time/i, 4],
  [/\brequirements?\b|how-to-apply|\bapply\b|\bapplication\b/i, 3],
  [/\badmissions?\b/i, 1],
];
// Application portals, logins, and news feeds never carry policy text.
const LINK_EXCLUDE_RE = /\/portal\/|\blogin\b|\bsign-?in\b|\bstatus\b|\bnews\b|\bblog|\bevents?\b|\bvisit\b|\btour\b|announcement/i;
const MIN_LANDING_LINK_SCORE = 3;
const MIN_DEEP_LINK_SCORE = 4;

function pathAndQuery(url) {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return ""; }
}

function scoreLink(url, anchorText) {
  const path = pathAndQuery(url);
  if (/\.(pdf|jpe?g|png|gif|zip|docx?)$/i.test(path)) return 0;
  if (LINK_EXCLUDE_RE.test(`${hostOf(url)}${path}`)) return 0;
  const text = `${path} ${anchorText}`;
  let score = 0;
  for (const [re, points] of LINK_SCORES) if (re.test(text)) score += points;
  return score;
}

// The school's registrable domain ("mit.edu" for web.mit.edu) and its
// distinctive token ("mit"). Scorecard often reports a deep homepage host,
// and "web" or "home" would match nothing.
export function schoolRootHost(host) {
  const labels = String(host || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  return labels.length > 2 ? labels.slice(-2).join(".") : labels.join(".");
}

export function schoolDomainToken(host) {
  return schoolRootHost(host).split(".")[0] || "";
}

// A host that carries the school's own domain token and says "admission"
// or "apply" (mit.edu → mitadmissions.org) is the school's admissions site.
function isSchoolAdmissionsHost(host, domainToken) {
  return domainToken.length >= 3 && host.includes(domainToken) && /admission|apply/i.test(host);
}

// Same-site links, plus — bounded — an off-site admissions host that carries
// the school's own domain token (mit.edu → mitadmissions.org): several
// schools run admissions on a separate domain, and refusing it means never
// seeing their policy pages at all.
export function rankedPolicyLinks(html, baseUrl, { allowedHosts = [], domainToken = "" } = {}) {
  const out = new Map();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const [, href, inner] = match;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let resolved;
    try { resolved = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(resolved)) continue;
    const anchor = htmlToText(inner).slice(0, 120);
    const onSite = sameSite(resolved, baseUrl) || allowedHosts.some((h) => sameSite(resolved, `https://${h}/`));
    let score = scoreLink(resolved, anchor);
    if (!onSite) {
      const host = hostOf(resolved);
      const admissionsHost = isSchoolAdmissionsHost(host, domainToken)
        || (domainToken.length >= 3 && host.includes(domainToken) && /admission|apply/i.test(anchor));
      if (!admissionsHost) continue;
      score += 2;
    }
    if (score <= 0) continue;
    const key = resolved.replace(/\/+$/, "");
    if (!out.has(key) || out.get(key).score < score) out.set(key, { url: resolved, score, offSite: !onSite });
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

async function gatherPolicyPages(homepage, fetcher) {
  const pages = [];
  const tried = new Set();
  const seenFinal = new Set();
  let fetches = 0;
  let blocked = 0;
  const origin = new URL(homepage).origin;
  const host = schoolRootHost(hostOf(homepage));
  const domainToken = schoolDomainToken(host);
  const allowedHosts = [];
  const linkOptions = () => ({ allowedHosts, domainToken });
  const acceptFinalUrl = (finalUrl) => {
    const finalHost = hostOf(finalUrl);
    return allowedHosts.some((h) => sameSite(finalUrl, `https://${h}/`)) || isSchoolAdmissionsHost(finalHost, domainToken);
  };

  const visit = async (url) => {
    const key = String(url || "").replace(/\/+$/, "");
    if (!key || tried.has(key) || pages.length >= MAX_PAGES_PER_SCHOOL || fetches >= MAX_FETCHES_PER_SCHOOL) return null;
    tried.add(key);
    fetches += 1;
    const page = await fetcher.page(url, { acceptFinalUrl });
    if (page?.blocked) { blocked += 1; return null; }
    if (!page) return null;
    // admission.<host> and admissions.<host> usually redirect to one place.
    const finalKey = String(page.url).replace(/\/+$/, "");
    if (seenFinal.has(finalKey)) return null;
    seenFinal.add(finalKey);
    const finalHost = hostOf(page.url);
    if (!sameSite(page.url, `https://${host}/`) && !allowedHosts.includes(finalHost)) allowedHosts.push(finalHost);
    pages.push(page);
    return page;
  };

  // The admissions office usually lives on its own subdomain; those landing
  // pages are the richest single source, so try them first.
  const landing = [];
  for (const sub of [`https://admission.${host}/`, `https://admissions.${host}/`]) {
    const page = await visit(sub);
    if (page) landing.push(page);
  }
  const home = await visit(homepage);
  if (home) landing.push(home);

  const ranked = [];
  for (const page of landing) ranked.push(...rankedPolicyLinks(page.html, page.url, linkOptions()));
  ranked.sort((a, b) => b.score - a.score);
  for (const link of ranked) {
    if (link.score < MIN_LANDING_LINK_SCORE) break;
    if (pages.length >= MAX_PAGES_PER_SCHOOL - 2 || fetches >= MAX_FETCHES_PER_SCHOOL - 3) break;
    if (link.offSite && !allowedHosts.includes(hostOf(link.url))) allowedHosts.push(hostOf(link.url));
    await visit(link.url);
  }
  if (pages.length < 3) {
    const origins = [origin, ...allowedHosts.map((h) => `https://${h}`)];
    for (const base of origins) {
      for (const path of PROBE_PATHS) {
        if (pages.length >= 3 || fetches >= MAX_FETCHES_PER_SCHOOL - 2) break;
        await visit(base + path);
      }
    }
  }
  // Deeper from the admissions pages: the testing and deadline pages are
  // usually one or two clicks below the landing page (home → admissions site
  // → first-year → tests & deadlines), so expand twice within the budget.
  const expanded = new Set();
  for (let round = 0; round < 2; round += 1) {
    const deeper = [];
    for (const page of pages.slice()) {
      if (expanded.has(page.url)) continue;
      expanded.add(page.url);
      deeper.push(...rankedPolicyLinks(page.html, page.url, linkOptions()).filter((l) => l.score >= MIN_DEEP_LINK_SCORE));
    }
    deeper.sort((a, b) => b.score - a.score);
    for (const link of deeper) {
      if (pages.length >= MAX_PAGES_PER_SCHOOL || fetches >= MAX_FETCHES_PER_SCHOOL) break;
      await visit(link.url);
    }
  }
  return { pages, fetches, blocked };
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
export async function runPolicyScout(targets, {
  stmts, factStmts, scorecardKey = null, fetchImpl = fetch, assertTarget = assertSafeFetchTarget,
  concurrency = 2, maxSchools = 60, trigger = "scheduled", now = () => new Date(), sleep,
} = {}) {
  const list = dedupeTargets(targets).slice(0, maxSchools);
  const runId = crypto.randomUUID();
  const startedAt = now().toISOString();
  // The version is recorded up front so an in-progress run reports the
  // scout that is actually running, not the previous run's.
  stmts.insertRun.run(runId, startedAt, trigger, list.length, JSON.stringify({ scoutVersion: SCOUT_VERSION, inProgress: true }));
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
    runId, trigger, startedAt, finishedAt: now().toISOString(), scoutVersion: SCOUT_VERSION,
    total: list.length, checked, failed, skipped: results.length - checked - failed, changes,
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
    schoolsTotal: row.schools_total,
    schoolsChecked: row.schools_checked,
    schoolsFailed: row.schools_failed,
    changes: row.changes,
  };
}
