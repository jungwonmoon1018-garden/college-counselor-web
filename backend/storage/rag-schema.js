// rag-schema.js — the RAG database's tables, the baseline seed and the prepared
// statements. Moved out of rag-engine.js on 2026-09-20, which re-exports
// them so its importers are unchanged.
import { initDirectionalityTable, prepareDirectionalityStatements } from "../activities/ec-vectorizer.js";
import { initAPConceptTables, prepareAPConceptStatements } from "../academics/ap-concept-vectorizer.js";
import { initECStrengthTables, prepareECStrengthStatements } from "../activities/ec-strength-vectorizer.js";
import { initNarrativeTables, prepareNarrativeStatements } from "../activities/narrative-store.js";
import { initNarrativeFitCacheTable, prepareNarrativeFitCacheStatements } from "../activities/narrative-fit-llm.js";

// ═══════════════════════════════════════════════════════════
// DATABASE SCHEMA — operational tables (no PII)
export function initRAGTables(db) {
  db.exec(`
    -- Versioned profile snapshots (PII-free: student_id is opaque UUID)
    CREATE TABLE IF NOT EXISTS profile_snapshots (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      gpa_unweighted REAL,
      gpa_weighted REAL,
      courses_json TEXT,
      ap_scores_json TEXT,
      test_scores_json TEXT,
      activities_json TEXT,
      major_interest TEXT,
      goals_json TEXT,
      trigger TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_snap_student ON profile_snapshots(student_id, created_at DESC);

    -- Milestone events (achievements, changes, progress markers)
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      data_json TEXT,
      academic_year TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mile_student ON milestones(student_id, created_at DESC);

    -- Capability timeline (numerical metrics over time for trend analysis)
    CREATE TABLE IF NOT EXISTS capability_timeline (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      percentile_national REAL,
      percentile_cohort REAL,
      computed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cap_student ON capability_timeline(student_id, metric, computed_at DESC);

    -- Baseline: GPA distributions
    CREATE TABLE IF NOT EXISTS baseline_gpa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      year INTEGER NOT NULL,
      percentile INTEGER NOT NULL,
      gpa_unweighted REAL,
      gpa_weighted REAL,
      source TEXT NOT NULL,
      UNIQUE(scope, year, percentile)
    );

    -- Baseline: SAT distributions
    CREATE TABLE IF NOT EXISTS baseline_sat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      year INTEGER NOT NULL,
      percentile INTEGER NOT NULL,
      score INTEGER NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(scope, year, percentile)
    );

    -- Baseline: ACT distributions
    CREATE TABLE IF NOT EXISTS baseline_act (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      year INTEGER NOT NULL,
      percentile INTEGER NOT NULL,
      score INTEGER NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(scope, year, percentile)
    );

    -- Baseline: EC benchmarks
    CREATE TABLE IF NOT EXISTS baseline_ec (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      participation_pct REAL,
      avg_hours REAL,
      leadership_pct REAL,
      impact_tier INTEGER,
      target_major TEXT,
      source TEXT,
      data_year INTEGER,
      UNIQUE(category, target_major, data_year)
    );

    -- Baseline: Expanded college profiles
    CREATE TABLE IF NOT EXISTS baseline_colleges (
      unit_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT,
      sat_25 INTEGER, sat_75 INTEGER,
      act_25 INTEGER, act_75 INTEGER,
      acceptance_rate REAL,
      enrollment INTEGER,
      tuition_in INTEGER, tuition_out INTEGER,
      avg_gpa_admitted REAL,
      ap_courses_valued_json TEXT,
      top_majors_json TEXT,
      ec_emphasis_json TEXT,
      yield_rate REAL,
      retention_rate REAL,
      grad_rate_6yr REAL,
      median_earnings_10yr INTEGER,
      data_year INTEGER,
      source TEXT DEFAULT 'NCES IPEDS',
      website TEXT
    );

    -- API usage log (per-student, per-call tracking — no PII, just opaque IDs)
    CREATE TABLE IF NOT EXISTS api_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      key_source TEXT NOT NULL DEFAULT 'shared',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_student ON api_usage_log(student_id, created_at DESC);

    -- ─── Chat history (multi-thread per student) ────────────────────────
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL,
      title TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      message_count INTEGER DEFAULT 0,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_threads_student ON chat_threads(student_id, archived_at, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      attachment_name TEXT,
      model_content TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON chat_messages(thread_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_content_search ON chat_messages(thread_id);

    -- ─── College core values cache ──────────────────────────────────────
    -- Once a student asks about "Stanford" once, we extract Stanford's
    -- stated values from its official admissions/about page and cache
    -- them for everyone. TTL: 90 days.
    CREATE TABLE IF NOT EXISTS college_values (
      slug TEXT PRIMARY KEY,                 -- normalized lower-case
      display_name TEXT NOT NULL,
      source_url TEXT,
      values_json TEXT NOT NULL,             -- [{theme, summary, evidence}]
      extracted_at TEXT DEFAULT (datetime('now')),
      extracted_by_student_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_values_extracted ON college_values(extracted_at DESC);

    -- Competitive activity benchmarks (granular, with qualifier levels)
    CREATE TABLE IF NOT EXISTS baseline_ec_competitive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id TEXT NOT NULL,
      activity_name TEXT NOT NULL,
      category TEXT NOT NULL,
      participation_rate REAL,
      source TEXT,
      data_year INTEGER,
      target_majors_json TEXT,
      qualifier_levels_json TEXT,
      keywords_json TEXT,
      UNIQUE(activity_id, data_year)
    );
    CREATE INDEX IF NOT EXISTS idx_ec_comp_category ON baseline_ec_competitive(category);
    CREATE INDEX IF NOT EXISTS idx_ec_comp_activity ON baseline_ec_competitive(activity_id);

    -- ── College Scorecard live cache ──────────────────────────────────────────
    -- Stores the most recent full normalized school record from the Scorecard
    -- API. Keyed by unit_id. Refreshed if older than 7 days.
    CREATE TABLE IF NOT EXISTS scorecard_cache (
      unit_id    TEXT PRIMARY KEY,
      name       TEXT,
      data_json  TEXT NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    -- Generic query cache for repeated Scorecard requests whose cache key is
    -- not just a single unit_id (search filters, compare matrices, aid views).
    CREATE TABLE IF NOT EXISTS scorecard_query_cache (
      cache_key   TEXT PRIMARY KEY,
      cache_kind  TEXT NOT NULL,
      query_json  TEXT NOT NULL,
      data_json   TEXT NOT NULL,
      fetched_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scorecard_query_kind ON scorecard_query_cache(cache_kind, fetched_at DESC);

    -- ── College Scorecard historical data ─────────────────────────────────────
    -- One row per school per academic-year label (e.g. 2019 = AY 2019-2020).
    -- Populated on demand when a student's goal list includes a school with a
    -- known unitId. The AI context pipeline reads these rows to surface
    -- multi-year admission-rate and cost trends for each target school.
    CREATE TABLE IF NOT EXISTS scorecard_history (
      unit_id         TEXT    NOT NULL,
      year            INTEGER NOT NULL,
      name            TEXT,
      admission_rate  REAL,    -- percent (e.g. 8.4 means 8.4%)
      sat_25          INTEGER, -- combined CR+Math 25th pctile
      sat_75          INTEGER, -- combined CR+Math 75th pctile
      act_25          INTEGER,
      act_75          INTEGER,
      tuition_in      INTEGER,
      tuition_out     INTEGER,
      avg_net_price   INTEGER,
      enrollment      INTEGER,
      grad_rate       REAL,    -- percent
      median_earnings INTEGER,
      fetched_at      TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (unit_id, year)
    );
    CREATE INDEX IF NOT EXISTS idx_scorecard_hist_unit ON scorecard_history(unit_id, year DESC);

    -- ── EC prestige research cache ─────────────────────────────────────────
    -- Stores prestige scores produced by the competition-research module.
    -- Keyed by sha256(normalizedActivityName || "|" || levelHint). TTL = 30d.
    -- source is one of "benchmark" | "catalog" | "research" | "research_failed".
    CREATE TABLE IF NOT EXISTS ec_prestige_cache (
      cache_key      TEXT PRIMARY KEY,
      activity_name  TEXT,
      level_hint     TEXT,
      score          REAL NOT NULL,
      rationale      TEXT,
      sources_json   TEXT,
      source         TEXT,
      provider       TEXT,
      model          TEXT,
      result_json    TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ec_prestige_activity ON ec_prestige_cache(activity_name);

    -- ── EC subvector component cache (all 5 factors) ───────────────────────
    -- Write-through cache for dedication/achievement/leadership/prestige/
    -- narrative_fit components. Keyed by sha256(factor || "|" || inputSig)
    -- so the per-factor recompute path short-circuits when inputs match.
    CREATE TABLE IF NOT EXISTS ec_component_cache (
      cache_key      TEXT PRIMARY KEY,
      factor         TEXT NOT NULL,
      score          REAL NOT NULL,
      reasoning_json TEXT,
      source         TEXT,
      provider       TEXT,
      model          TEXT,
      input_sig      TEXT NOT NULL,
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ec_component_cache_factor ON ec_component_cache(factor);

    -- Student-entered deadlines (F7 from Jiyeon UX audit). The backend
    -- already knows generic admissions dates (data/admissions-deadlines.json)
    -- but a scared kid also tracks personal milestones: "finish MIT essay",
    -- "mail certificate to dad", "AP BioChem registration". Those live here.
    CREATE TABLE IF NOT EXISTS student_deadlines (
      id           TEXT PRIMARY KEY,
      student_id   TEXT NOT NULL,
      title        TEXT NOT NULL,
      due_at       TEXT NOT NULL,           -- ISO-8601 date or datetime
      category     TEXT DEFAULT 'personal', -- personal | admissions | financial_aid | test | other
      notes        TEXT,
      college_ids_json TEXT,                -- optional list of unit_ids this deadline pertains to
      status       TEXT DEFAULT 'open',     -- open | done | snoozed
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_student_deadlines_student ON student_deadlines(student_id, due_at);
    CREATE INDEX IF NOT EXISTS idx_student_deadlines_status  ON student_deadlines(student_id, status);

    -- ─── Common Data Set records (school-level CDS ground truth) ─────
    -- Persists a fully-parsed + validated CDS record per institution,
    -- keyed by slug (e.g. "princeton-university"). The positioning engine
    -- reads from this table for school-level signals: admit rate, SAT/ACT
    -- bands, GPA bands, C7 factor importance ratings, test policy.
    --
    -- Provenance: cds-search.js + cds-pdf-parser.js fetch and parse the PDF;
    -- cds-validator.js cross-checks against authoritative sources and
    -- writes overrides into cds_validations rather than mutating the
    -- record itself, so the ingestion path stays auditable.
    CREATE TABLE IF NOT EXISTS cds_records (
      slug                TEXT PRIMARY KEY,
      school_name         TEXT NOT NULL,
      year_label          TEXT,                 -- "2023-24"
      year                INTEGER,              -- 2024 (calendar year of CDS reporting)
      tier                TEXT,                 -- T20 | Sub-Ivy | T50 | T100 | LAC | Other
      overall_admit_rate  REAL,
      yield_rate          REAL,
      enrolled_sat_p25    INTEGER,
      enrolled_sat_p75    INTEGER,
      enrolled_act_p25    INTEGER,
      enrolled_act_p75    INTEGER,
      enrolled_gpa_p25    REAL,
      enrolled_gpa_p75    REAL,
      test_policy         TEXT,                 -- test_required | test_optional | test_blind
      c7_json             TEXT,                 -- {"gpa":"very_important",...}
      b1_json             TEXT,                 -- {"applied":...,"admitted":...,"enrolled":...}
      majors_json         TEXT,                 -- per-major capped/direct-admit overlays (CIP code level)
      priorities_json     TEXT,                 -- institutional strategic priorities for fit-bonus
      source_url          TEXT,                 -- URL of the original CDS PDF
      source_kind         TEXT,                 -- pdf_text | pdf_form | pdf_merged | xlsx
      parser_version      INTEGER DEFAULT 1,
      parser_notes_json   TEXT,
      ingested_at         TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cds_records_tier ON cds_records(tier);
    CREATE INDEX IF NOT EXISTS idx_cds_records_admit ON cds_records(overall_admit_rate);

    -- ─── CDS validation log ─────────────────────────────────────────
    -- Append-only history of every validation pass: discrepancies found,
    -- overrides applied, ground-truth source URLs. The latest row per
    -- slug is what cds-validator.js::loadValidatedRecord() consults
    -- before returning a record to the positioning engine.
    --
    -- Severity vocabulary:
    --   critical → scope mismatch (PDF is for wrong institution)
    --   high     → admit-rate drift > 0.5pp, SAT mis-parse, parser miss
    --   medium   → SAT band drift 30-60 points, GPA band drift
    --   low      → cosmetic / metadata drift
    CREATE TABLE IF NOT EXISTS cds_validations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      slug            TEXT NOT NULL,
      status          TEXT NOT NULL,            -- ok | discrepancies | scope_mismatch | no_truth
      scope_from_pdf  TEXT,
      discrepancies_json TEXT,                  -- [{severity,field,parsed,expected,note}]
      overrides_json     TEXT,                  -- {overallAdmitRate,enrolledSAT,...}
      sources_json       TEXT,                  -- ground-truth URLs cited
      validated_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cds_validations_slug ON cds_validations(slug, validated_at);
  `);

  // ─── Additive migrations on cds_records (idempotent) ─────────────
  // Columns added after the initial release land here so existing
  // SQLite files upgrade without manual intervention. Pattern mirrors
  // ec-strength-vectorizer.js::initECStrengthTables.
  try {
    // The student's class rank (top share, rank, class size) — read by the
    // College Fit calculation against a school's C10 shares.
    const snapshotCols = db.prepare(`PRAGMA table_info(profile_snapshots)`).all().map((r) => r.name);
    if (!snapshotCols.includes("class_rank_json")) {
      db.exec(`ALTER TABLE profile_snapshots ADD COLUMN class_rank_json TEXT`);
    }
    // The survey's "no GPA yet" (gpa_status "pending") and "no test taken
    // yet" (testing_status "planned"). They were never stored, so the chat
    // could tell "none yet" from "not entered" only while the device still
    // sent them (fid-5). A save writes "" for "no such statement"; NULL is a
    // row from before these columns, which says nothing either way.
    if (!snapshotCols.includes("gpa_status")) {
      db.exec(`ALTER TABLE profile_snapshots ADD COLUMN gpa_status TEXT`);
    }
    if (!snapshotCols.includes("testing_status")) {
      db.exec(`ALTER TABLE profile_snapshots ADD COLUMN testing_status TEXT`);
    }
  } catch (err) {
    console.warn("[RAG] profile_snapshots migration warning:", err.message);
  }
  // student_deadlines.snooze_until — the calendar date (YYYY-MM-DD) a
  // snoozed deadline comes back. "Snoozed" had no end: the row left the
  // upcoming and overdue counts for good, so a snoozed application
  // deadline never reminded the student again (input-4).
  try {
    const deadlineCols = db.prepare(`PRAGMA table_info(student_deadlines)`).all().map((r) => r.name);
    if (!deadlineCols.includes("snooze_until")) {
      db.exec(`ALTER TABLE student_deadlines ADD COLUMN snooze_until TEXT`);
    }
  } catch (err) {
    console.warn("[RAG] student_deadlines migration warning:", err.message);
  }
  // Milestone titles written before the source-encoding repair (debt-8)
  // carry "??" where the arrow or the dash was lost: "GPA improved: 3.80
  // ??3.90". GET /api/students/milestones serves them as stored, so they
  // are repaired in place; a repaired title no longer matches, which makes
  // this a no-op on every later boot. Only the four titles that ever held
  // the character are touched.
  try {
    db.prepare(`UPDATE milestones SET title = replace(title, ' ??', ' → ') WHERE type IN ('gpa_change', 'test_score_updated', 'major_changed') AND title LIKE '% ??%'`).run();
    db.prepare(`UPDATE milestones SET title = replace(title, ' ??', ' — ') WHERE type = 'ec_leadership' AND title LIKE '% ??%'`).run();
  } catch (err) {
    console.warn("[RAG] milestone title repair warning:", err.message);
  }
  // capability_timeline.snapshot_id — the snapshot each percentile row was
  // computed from. The latest metrics used to be "the newest row per
  // metric", so a score the student cleared kept its last row as the newest
  // one: a deleted SAT 1600 still read "sat_total percentile: 99th" in the
  // context bundle, and two syncs in one second gave two rows for a metric.
  // Reading only the rows of the latest snapshot fixes both; older rows,
  // which carry no snapshot, are history (getCapabilityTrend) and are linked
  // to the latest snapshot once by backfillLatestCapabilities.
  try {
    const capCols = db.prepare(`PRAGMA table_info(capability_timeline)`).all().map((r) => r.name);
    if (!capCols.includes("snapshot_id")) {
      db.exec(`ALTER TABLE capability_timeline ADD COLUMN snapshot_id TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cap_snapshot ON capability_timeline(student_id, snapshot_id)`);
  } catch (err) {
    console.warn("[RAG] capability_timeline migration warning:", err.message);
  }
  try {
    const cdsCols = db.prepare(`PRAGMA table_info(cds_records)`).all().map((r) => r.name);
    if (!cdsCols.includes("enrolled_gpa_avg")) {
      db.exec(`ALTER TABLE cds_records ADD COLUMN enrolled_gpa_avg REAL`);
    }
    if (!cdsCols.includes("c1_breakdown_json")) {
      db.exec(`ALTER TABLE cds_records ADD COLUMN c1_breakdown_json TEXT`);
    }
    // Sections beyond C1/C7/C9/C12: SAT section bands, submit rates, class
    // rank, application fee, ED counts, closing dates, aid package, ratio.
    if (!cdsCols.includes("extras_json")) {
      db.exec(`ALTER TABLE cds_records ADD COLUMN extras_json TEXT`);
    }
  } catch (err) {
    console.warn("[RAG] cds_records migration warning:", err.message);
  }

  // baseline_colleges.website — each college's official site (from Scorecard
  // school.school_url). Lets the seasonal researcher scope web search to that
  // college's own .edu host. Added after initial release.
  try {
    const colCols = db.prepare(`PRAGMA table_info(baseline_colleges)`).all().map((r) => r.name);
    if (!colCols.includes("website")) {
      db.exec(`ALTER TABLE baseline_colleges ADD COLUMN website TEXT`);
    }
  } catch (err) {
    console.warn("[RAG] baseline_colleges migration warning:", err.message);
  }

  // Directionality vectors (overall academic trajectory and fit)
  initDirectionalityTable(db);

  // AP concept components — subject vectors are decomposed into weighted
  // concept components. LAZY-populated: rows appear only once the student's
  // own prompts/files reference the subject. See ap-concept-vectorizer.js.
  initAPConceptTables(db);

  // Unified EC strength vectors + uploaded attachment metadata.
  initECStrengthTables(db);

  // Student self-written narratives (versioned). Feeds the narrative_fit
  // factor of the 4-factor strength vector.
  initNarrativeTables(db);

  // Haiku-backed narrative_fit LLM cache (only hit when keyword overlap
  // is inconclusive).
  initNarrativeFitCacheTable(db);
}

// ═══════════════════════════════════════════════════════════
// SEED BASELINE DATA
export function seedBaselines(db, { GPA_BASELINES, SAT_BASELINES, ACT_BASELINES, EC_BENCHMARKS, COLLEGE_PROFILES, COMPETITIVE_ACTIVITY_BENCHMARKS }) {
  const normalizeRate = (value) => {
    if (value == null || value === "") return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return num > 1 ? num / 100 : num;
  };

  const tx = db.transaction(() => {
    const gpaStmt = db.prepare(`INSERT OR REPLACE INTO baseline_gpa (scope, year, percentile, gpa_unweighted, gpa_weighted, source) VALUES (?,?,?,?,?,?)`);
    for (const g of GPA_BASELINES) gpaStmt.run(g.scope, g.year, g.percentile, g.gpa_unweighted, g.gpa_weighted, g.source);

    const satStmt = db.prepare(`INSERT OR REPLACE INTO baseline_sat (scope, year, percentile, score, source) VALUES (?,?,?,?,?)`);
    for (const s of SAT_BASELINES) satStmt.run(s.scope, s.year, s.percentile, s.score, s.source);

    const actStmt = db.prepare(`INSERT OR REPLACE INTO baseline_act (scope, year, percentile, score, source) VALUES (?,?,?,?,?)`);
    for (const a of ACT_BASELINES) actStmt.run(a.scope, a.year, a.percentile, a.score, a.source);

    const ecStmt = db.prepare(`INSERT OR REPLACE INTO baseline_ec (category, participation_pct, avg_hours, leadership_pct, impact_tier, target_major, source, data_year) VALUES (?,?,?,?,?,?,?,?)`);
    for (const e of EC_BENCHMARKS) ecStmt.run(e.category, e.participation_pct, e.avg_hours, e.leadership_pct, e.impact_tier, e.target_major, e.source, e.year);

    const colStmt = db.prepare(`INSERT OR REPLACE INTO baseline_colleges (unit_id, name, state, sat_25, sat_75, act_25, act_75, acceptance_rate, enrollment, tuition_in, tuition_out, avg_gpa_admitted, ap_courses_valued_json, top_majors_json, ec_emphasis_json, yield_rate, retention_rate, grad_rate_6yr, median_earnings_10yr, data_year, website) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const c of COLLEGE_PROFILES) {
      colStmt.run(
        c.unitId, c.name, c.state, c.sat25, c.sat75, c.act25, c.act75,
        normalizeRate(c.acceptance), c.enrollment, c.tuitionIn, c.tuitionOut,
        c.avgGpaAdmitted,
        JSON.stringify(c.apCoursesValued || []),
        JSON.stringify(c.topMajors || []),
        JSON.stringify(c.ecEmphasis || []),
        normalizeRate(c.yieldRate), normalizeRate(c.retentionRate),
        normalizeRate(c.gradRate6yr), c.medianEarnings10yr, c.dataYear,
        c.website || c.url || null
      );
    }

    // Competitive activity benchmarks (granular)
    if (COMPETITIVE_ACTIVITY_BENCHMARKS?.length) {
      const compStmt = db.prepare(`INSERT OR REPLACE INTO baseline_ec_competitive (activity_id, activity_name, category, participation_rate, source, data_year, target_majors_json, qualifier_levels_json, keywords_json) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const c of COMPETITIVE_ACTIVITY_BENCHMARKS) {
        compStmt.run(c.activity_id, c.activity_name, c.category, c.participation_rate, c.source, c.year, JSON.stringify(c.target_majors), JSON.stringify(c.qualifier_levels), JSON.stringify(c.keywords));
      }
    }
  });
  tx();
  console.log(`[RAG] Baselines seeded: ${GPA_BASELINES.length} GPA, ${SAT_BASELINES.length} SAT, ${ACT_BASELINES.length} ACT, ${EC_BENCHMARKS.length} EC, ${COLLEGE_PROFILES.length} colleges, ${COMPETITIVE_ACTIVITY_BENCHMARKS?.length || 0} competitive`);
}

// Backfill baseline_colleges.website from the Scorecard cache (school.school_url
// is captured into the cached payload as `.website`). Best-effort: only fills
// rows where website is currently empty, so static seed values win. Returns the
// number of rows updated. Used by the seasonal researcher to scope web search
// to each college's official .edu host.
export function hydrateBaselineWebsites(db) {
  let updated = 0;
  try {
    // Nothing to backfill from if the Scorecard cache hasn't been created yet.
    const hasCache = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='scorecard_cache'`).get();
    if (!hasCache) return 0;
    const rows = db.prepare(`SELECT unit_id, data_json FROM scorecard_cache`).all();
    const upd = db.prepare(`UPDATE baseline_colleges SET website = ? WHERE unit_id = ? AND (website IS NULL OR website = '')`);
    const tx = db.transaction(() => {
      for (const r of rows) {
        let data;
        try { data = JSON.parse(r.data_json || "{}"); } catch { continue; }
        const site = data.website || data.school_url || data["school.school_url"] || "";
        if (!site || typeof site !== "string") continue;
        const res = upd.run(site.trim(), r.unit_id);
        updated += res.changes;
      }
    });
    tx();
  } catch (err) {
    console.warn("[RAG] hydrateBaselineWebsites warning:", err.message);
  }
  return updated;
}

// Profile history compaction. Every auto-sync used to append a snapshot and
// five capability rows, unchanged or not, and nothing ever deleted one: with
// a sync after each chat answer and seven daily backups of counselor.db,
// that runs a 1 GB disk out within an application season, and a full disk
// fails every write for every student. A sync that changes nothing no longer
// writes (syncStudentData); this keeps each student's newest snapshots, the
// capability rows computed from them, a bounded window of the older rows that
// carry no snapshot, and a bounded window of milestones (events, which outlive
// the snapshot they came from; the route shows at most 100). Run daily and at
// boot from the batch jobs.
export const PROFILE_HISTORY_LIMITS = Object.freeze({
  snapshotsPerStudent: 50,
  unlinkedCapabilitiesPerMetric: 50,
  milestonesPerStudent: 200,
});

export function compactProfileHistory(db, limits = PROFILE_HISTORY_LIMITS) {
  const keep = { ...PROFILE_HISTORY_LIMITS, ...(limits || {}) };
  const tx = db.transaction(() => {
    const snapshots = db.prepare(`
      DELETE FROM profile_snapshots WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY datetime(created_at) DESC, rowid DESC) AS rn
          FROM profile_snapshots
        ) WHERE rn > ?
      )`).run(keep.snapshotsPerStudent).changes;
    const linkedCapabilities = db.prepare(`
      DELETE FROM capability_timeline
      WHERE snapshot_id IS NOT NULL AND snapshot_id NOT IN (SELECT id FROM profile_snapshots)`).run().changes;
    const unlinkedCapabilities = db.prepare(`
      DELETE FROM capability_timeline WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY student_id, metric ORDER BY datetime(computed_at) DESC, rowid DESC) AS rn
          FROM capability_timeline WHERE snapshot_id IS NULL
        ) WHERE rn > ?
      )`).run(keep.unlinkedCapabilitiesPerMetric).changes;
    const milestones = db.prepare(`
      DELETE FROM milestones WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY datetime(created_at) DESC, rowid DESC) AS rn
          FROM milestones
        ) WHERE rn > ?
      )`).run(keep.milestonesPerStudent).changes;
    return { snapshots, linkedCapabilities, unlinkedCapabilities, milestones };
  });
  const counts = tx();
  // `deleted` is the total, so the batch runner logs a run that removed rows.
  return { deleted: counts.snapshots + counts.linkedCapabilities + counts.unlinkedCapabilities + counts.milestones, ...counts };
}

// ═══════════════════════════════════════════════════════════
// PREPARED STATEMENTS
export function prepareRAGStatements(db) {
  // Migration: chat_messages.model_content — the model-facing copy of a user
  // message (file-attachment context included), so reopening a thread can
  // replay the full context instead of losing every uploaded file on reload.
  try {
    const chatMessageColumns = db.prepare("PRAGMA table_info(chat_messages)").all();
    if (chatMessageColumns.length && !chatMessageColumns.some((column) => column.name === "model_content")) {
      db.exec("ALTER TABLE chat_messages ADD COLUMN model_content TEXT");
    }
  } catch { /* table created fresh below with the column present */ }
  return {
    // Runs fn in one transaction on this database: a sync's snapshot, class
    // rank, milestones and capability rows land together or not at all.
    inTransaction: (fn) => db.transaction(fn)(),

    // Snapshots
    insertSnapshot: db.prepare(`INSERT INTO profile_snapshots (id, student_id, snapshot_type, gpa_unweighted, gpa_weighted, courses_json, ap_scores_json, test_scores_json, activities_json, major_interest, goals_json, trigger) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    // Class rank rides in its own column, set right after the insert so the
    // registration path and older callers keep their twelve-value insert.
    setSnapshotClassRank: db.prepare(`UPDATE profile_snapshots SET class_rank_json = ? WHERE id = ?`),
    // The GPA and testing statuses, set the same way.
    setSnapshotStatuses: db.prepare(`UPDATE profile_snapshots SET gpa_status = ?, testing_status = ? WHERE id = ?`),
    getLatestSnapshot: db.prepare(`SELECT * FROM profile_snapshots WHERE student_id = ? ORDER BY datetime(created_at) DESC, rowid DESC LIMIT 1`),
    getSnapshotHistory: db.prepare(`SELECT id, snapshot_type, gpa_unweighted, gpa_weighted, major_interest, trigger, created_at FROM profile_snapshots WHERE student_id = ? ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?`),

    // Milestones
    insertMilestone: db.prepare(`INSERT INTO milestones (id, student_id, type, title, data_json, academic_year) VALUES (?,?,?,?,?,?)`),
    getMilestones: db.prepare(`SELECT * FROM milestones WHERE student_id = ? ORDER BY created_at DESC LIMIT ?`),
    getMilestonesByType: db.prepare(`SELECT * FROM milestones WHERE student_id = ? AND type = ? ORDER BY created_at DESC LIMIT ?`),

    // Capability timeline. A row carries the snapshot it was computed from
    // (the seventh value); the latest metrics are that snapshot's rows only,
    // so a metric the latest snapshot does not have is not reported.
    insertCapability: db.prepare(`INSERT INTO capability_timeline (id, student_id, metric, value, percentile_national, percentile_cohort, snapshot_id) VALUES (?,?,?,?,?,?,?)`),
    getLatestCapabilities: db.prepare(`
      SELECT c.metric, c.value, c.percentile_national, c.percentile_cohort, c.computed_at
      FROM capability_timeline c
      WHERE c.student_id = ? AND c.snapshot_id = (
        SELECT s.id FROM profile_snapshots s WHERE s.student_id = c.student_id
        ORDER BY datetime(s.created_at) DESC, s.rowid DESC LIMIT 1)
      ORDER BY c.rowid ASC`),
    countCapabilitiesForSnapshot: db.prepare(`SELECT COUNT(*) AS n FROM capability_timeline WHERE snapshot_id = ?`),
    // Students with percentile rows from before snapshot_id existed whose
    // latest snapshot has none linked yet: the one-time backfill's work list.
    latestSnapshotsWithoutCapabilities: db.prepare(`
      SELECT s.* FROM profile_snapshots s
      WHERE s.rowid = (SELECT s2.rowid FROM profile_snapshots s2 WHERE s2.student_id = s.student_id
                       ORDER BY datetime(s2.created_at) DESC, s2.rowid DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM capability_timeline c WHERE c.snapshot_id = s.id)
        AND EXISTS (SELECT 1 FROM capability_timeline c WHERE c.student_id = s.student_id)`),
    getCapabilityTrend: db.prepare(`SELECT metric, value, percentile_national, computed_at FROM capability_timeline WHERE student_id = ? AND metric = ? ORDER BY computed_at ASC, rowid ASC`),

    // Baselines
    getGPABaseline: db.prepare(`SELECT * FROM baseline_gpa WHERE scope = ? ORDER BY percentile ASC`),
    getSATBaseline: db.prepare(`SELECT * FROM baseline_sat WHERE scope = ? ORDER BY percentile ASC`),
    getACTBaseline: db.prepare(`SELECT * FROM baseline_act WHERE scope = ? ORDER BY percentile ASC`),
    getECBaseline: db.prepare(`SELECT * FROM baseline_ec WHERE target_major = ? OR target_major = 'General' ORDER BY impact_tier DESC`),
    getCollegeProfile: db.prepare(`SELECT * FROM baseline_colleges WHERE unit_id = ?`),
    searchColleges: db.prepare(`SELECT * FROM baseline_colleges ORDER BY acceptance_rate ASC`),
    getCollegesByState: db.prepare(`SELECT * FROM baseline_colleges WHERE state = ?`),

    // API usage log
    insertUsage: db.prepare(`INSERT INTO api_usage_log (student_id, model, input_tokens, output_tokens, key_source) VALUES (?,?,?,?,?)`),
    getUsageToday: db.prepare(`SELECT SUM(input_tokens) as input_total, SUM(output_tokens) as output_total, COUNT(*) as call_count FROM api_usage_log WHERE student_id = ? AND created_at >= datetime('now', '-24 hours')`),
    getUsageMonth: db.prepare(`SELECT SUM(input_tokens) as input_total, SUM(output_tokens) as output_total, COUNT(*) as call_count FROM api_usage_log WHERE student_id = ? AND created_at >= datetime('now', '-30 days')`),
    getUsageHistory: db.prepare(`SELECT date(created_at) as day, SUM(input_tokens) as input_total, SUM(output_tokens) as output_total, COUNT(*) as call_count, key_source FROM api_usage_log WHERE student_id = ? GROUP BY day, key_source ORDER BY day DESC LIMIT ?`),
    // Per-model rollup over the last 30 days — used by the budget tracker.
    getUsageHistoryByModel: db.prepare(`SELECT model, SUM(input_tokens) as input_total, SUM(output_tokens) as output_total FROM api_usage_log WHERE student_id = ? AND created_at >= datetime('now', '-30 days') GROUP BY model`),

    // ─── Chat threads ───
    createThread: db.prepare(`INSERT INTO chat_threads (id, student_id, title) VALUES (?, ?, ?)`),
    listThreads: db.prepare(`SELECT id, title, created_at, updated_at, message_count FROM chat_threads WHERE student_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`),
    getThread: db.prepare(`SELECT * FROM chat_threads WHERE id = ? AND student_id = ?`),
    updateThreadTitle: db.prepare(`UPDATE chat_threads SET title = ?, updated_at = datetime('now') WHERE id = ? AND student_id = ?`),
    touchThread: db.prepare(`UPDATE chat_threads SET updated_at = datetime('now'), message_count = message_count + ? WHERE id = ?`),
    archiveThread: db.prepare(`UPDATE chat_threads SET archived_at = datetime('now') WHERE id = ? AND student_id = ?`),
    deleteThreadHard: db.prepare(`DELETE FROM chat_threads WHERE id = ? AND student_id = ?`),
    deleteThreadMessages: db.prepare(`DELETE FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE id = ? AND student_id = ?)`),
    insertMessage: db.prepare(`INSERT INTO chat_messages (thread_id, role, content, attachment_name, model_content) VALUES (?, ?, ?, ?, ?)`),
    // The NEWEST n messages, oldest first. This read was "ORDER BY id ASC
    // LIMIT 500": a thread past 500 rows reopened at its oldest 500, and
    // every newer answer vanished on reload.
    listMessages: db.prepare(`
      SELECT id, role, content, attachment_name, model_content, created_at FROM (
        SELECT id, role, content, attachment_name, model_content, created_at
        FROM chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC`),
    countMessages: db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?`),
    // Message bodies are encrypted. Fetch a bounded set of candidates and
    // decrypt/filter inside chat-history.js instead of applying SQL LIKE.
    searchMessages: db.prepare(`
      SELECT m.id, m.thread_id, m.role, m.content, m.created_at, t.title
      FROM chat_messages m JOIN chat_threads t ON m.thread_id = t.id
      WHERE t.student_id = ? AND t.archived_at IS NULL
      ORDER BY m.id DESC LIMIT ?
    `),

    // ─── College values ───
    getCollegeValues:    db.prepare(`SELECT slug, display_name, source_url, values_json, extracted_at FROM college_values WHERE slug = ?`),
    // Clear every cache entry this student created — used by the
    // /api/colleges/values DELETE endpoint. Leaves entries that were
    // extracted by other students untouched.
    deleteCollegeValuesByStudent: db.prepare(`DELETE FROM college_values WHERE extracted_by_student_id = ?`),
    upsertCollegeValues: db.prepare(`
      INSERT INTO college_values (slug, display_name, source_url, values_json, extracted_at, extracted_by_student_id)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(slug) DO UPDATE SET
        display_name = excluded.display_name,
        source_url   = excluded.source_url,
        values_json  = excluded.values_json,
        extracted_at = datetime('now')
    `),

    // Competitive activity benchmarks
    getCompetitiveBenchmark: db.prepare(`SELECT * FROM baseline_ec_competitive WHERE activity_id = ?`),
    getAllCompetitiveBenchmarks: db.prepare(`SELECT * FROM baseline_ec_competitive ORDER BY activity_id`),

    // Scorecard live cache
    upsertScorecardCache:   db.prepare(`INSERT OR REPLACE INTO scorecard_cache (unit_id, name, data_json, fetched_at) VALUES (?,?,?,datetime('now'))`),
    getScorecardCache:      db.prepare(`SELECT * FROM scorecard_cache WHERE unit_id = ? AND fetched_at >= datetime('now','-7 days')`),
    getScorecardCacheAny:   db.prepare(`SELECT * FROM scorecard_cache WHERE unit_id = ?`),
    upsertScorecardQueryCache: db.prepare(`INSERT OR REPLACE INTO scorecard_query_cache (cache_key, cache_kind, query_json, data_json, fetched_at) VALUES (?,?,?,?,datetime('now'))`),
    getScorecardQueryCache:    db.prepare(`SELECT * FROM scorecard_query_cache WHERE cache_key = ? AND fetched_at >= datetime('now','-7 days')`),
    getScorecardQueryCacheAny: db.prepare(`SELECT * FROM scorecard_query_cache WHERE cache_key = ?`),
    deleteScorecardQueryCacheOlderThan: db.prepare(`DELETE FROM scorecard_query_cache WHERE fetched_at < datetime('now', ?)`),

    // Scorecard historical rows
    upsertScorecardHistory: db.prepare(`INSERT OR REPLACE INTO scorecard_history (unit_id, year, name, admission_rate, sat_25, sat_75, act_25, act_75, tuition_in, tuition_out, avg_net_price, enrollment, grad_rate, median_earnings) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    getScorecardHistory:    db.prepare(`SELECT * FROM scorecard_history WHERE unit_id = ? ORDER BY year DESC`),
    getLatestScorecardYear: db.prepare(`SELECT fetched_at FROM scorecard_history WHERE unit_id = ? ORDER BY fetched_at DESC LIMIT 1`),

    // EC prestige research cache (30-day TTL; check via created_at).
    getPrestigeCache:     db.prepare(`SELECT * FROM ec_prestige_cache WHERE cache_key = ?`),
    getPrestigeCacheByName: db.prepare(`SELECT * FROM ec_prestige_cache WHERE activity_name = ? ORDER BY created_at DESC LIMIT 1`),
    upsertPrestigeCache:  db.prepare(`INSERT OR REPLACE INTO ec_prestige_cache (cache_key, activity_name, level_hint, score, rationale, sources_json, source, provider, model, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`),

    // EC subvector component cache (all 5 factors).
    getComponentCache:    db.prepare(`SELECT * FROM ec_component_cache WHERE cache_key = ?`),
    upsertComponentCache: db.prepare(`INSERT OR REPLACE INTO ec_component_cache (cache_key, factor, score, reasoning_json, source, provider, model, input_sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`),

    // ─── Common Data Set records + validations ──────────────────────
    // The cds object groups read/write paths. The positioning engine and
    // server endpoints use `cds.getBySlug` for runtime lookups; the
    // ingester pipeline uses `cds.upsert` after PDF parse + validation.
    cds: {
      getBySlug: db.prepare(`SELECT * FROM cds_records WHERE slug = ?`),
      listAll: db.prepare(`SELECT * FROM cds_records ORDER BY school_name`),
      listByTier: db.prepare(`SELECT * FROM cds_records WHERE tier = ? ORDER BY overall_admit_rate ASC`),
      countAll: db.prepare(`SELECT COUNT(*) AS total FROM cds_records`),
      upsert: db.prepare(`
        INSERT OR REPLACE INTO cds_records
          (slug, school_name, year_label, year, tier,
           overall_admit_rate, yield_rate,
           enrolled_sat_p25, enrolled_sat_p75,
           enrolled_act_p25, enrolled_act_p75,
           enrolled_gpa_p25, enrolled_gpa_p75, enrolled_gpa_avg,
           test_policy, c7_json, b1_json, c1_breakdown_json,
           majors_json, priorities_json,
           source_url, source_kind, parser_version, parser_notes_json, extras_json,
           ingested_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                COALESCE((SELECT ingested_at FROM cds_records WHERE slug = ?), datetime('now')),
                datetime('now'))
      `),
      delete: db.prepare(`DELETE FROM cds_records WHERE slug = ?`),
      // Validation history (append-only)
      insertValidation: db.prepare(`
        INSERT INTO cds_validations (slug, status, scope_from_pdf, discrepancies_json, overrides_json, sources_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      latestValidation: db.prepare(`
        SELECT * FROM cds_validations WHERE slug = ?
        ORDER BY datetime(validated_at) DESC, id DESC LIMIT 1
      `),
      listValidationsRecent: db.prepare(`
        SELECT * FROM cds_validations ORDER BY datetime(validated_at) DESC, id DESC LIMIT ?
      `),
    },

    // Student personal deadlines (F7 from Jiyeon UX audit).
    deadlines: {
      insert: db.prepare(`INSERT INTO student_deadlines (id, student_id, title, due_at, category, notes, college_ids_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      getById: db.prepare(`SELECT * FROM student_deadlines WHERE id = ? AND student_id = ?`),
      listByStudent: db.prepare(`SELECT * FROM student_deadlines WHERE student_id = ? ORDER BY datetime(due_at) ASC, created_at ASC`),
      listOpenByStudent: db.prepare(`SELECT * FROM student_deadlines WHERE student_id = ? AND status = 'open' ORDER BY datetime(due_at) ASC`),
      updateStatus: db.prepare(`UPDATE student_deadlines SET status = ?, updated_at = datetime('now') WHERE id = ? AND student_id = ?`),
      setSnoozeUntil: db.prepare(`UPDATE student_deadlines SET snooze_until = ?, updated_at = datetime('now') WHERE id = ? AND student_id = ?`),
      updateFields: db.prepare(`UPDATE student_deadlines SET title = COALESCE(?, title), due_at = COALESCE(?, due_at), category = COALESCE(?, category), notes = COALESCE(?, notes), college_ids_json = COALESCE(?, college_ids_json), updated_at = datetime('now') WHERE id = ? AND student_id = ?`),
      delete: db.prepare(`DELETE FROM student_deadlines WHERE id = ? AND student_id = ?`),
      // Cascade delete when a university is removed from the college list.
      // The route escapes the title pattern, and JSON membership is exact so
      // a short unitId cannot match a different school's longer identifier.
      deleteBySchool: db.prepare(`
        DELETE FROM student_deadlines
        WHERE student_id = ?
          AND ( LOWER(title) LIKE ? ESCAPE '!'
             OR (? IS NOT NULL AND EXISTS (
               SELECT 1
               FROM json_each(
                 CASE
                   WHEN json_valid(student_deadlines.college_ids_json)
                     THEN student_deadlines.college_ids_json
                   ELSE '[]'
                 END
               )
               WHERE CAST(json_each.value AS TEXT) = ?
             )) )
      `),
      countOpenUpcoming: db.prepare(`SELECT COUNT(*) AS total FROM student_deadlines WHERE student_id = ? AND status = 'open' AND date(due_at) >= date('now')`),
    },

    // Directionality vector statements
    directionality: prepareDirectionalityStatements(db),

    // AP concept statements (per-subject concept components).
    // These drive lazy initialization: rows are inserted only when the
    // student's own evidence references the subject.
    apConcepts: prepareAPConceptStatements(db),

    // EC strength (4-factor) statements + attachment metadata.
    strength: prepareECStrengthStatements(db),

    // Versioned narrative store (self-presentation).
    narrative: prepareNarrativeStatements(db),

    // narrative_fit LLM result cache.
    narrativeFitCache: prepareNarrativeFitCacheStatements(db),
  };
}
