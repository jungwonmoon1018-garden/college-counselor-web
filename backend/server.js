// ═══════════════════════════════════════════════════════════════════════
// COLLEGE COUNSELOR — WEB BACKEND
// ═══════════════════════════════════════════════════════════════════════
// The web launcher starts this Express composition root on the hosting port.
// Student routes require an authenticated student session and ownership
// checks. The localhost administrator is limited to installation secrets.
//
// Advice flows through deterministic safety/policy rules, verified evidence,
// fixed OpenRouter dispatch when a model is needed, output screening, and
// explicit verified/student-provided/coaching lanes. Student content is
// encrypted at rest across the PII vault and chat store.
//
// Retired public dashboards, parent notification, generic provider/BYOK, and
// setup-token surfaces remain only as explicit compatibility responses where
// old clients may still call them.
// ═══════════════════════════════════════════════════════════════════════

import dotenv from "dotenv";
// Override empty-string OS env vars (e.g. inherited "" from a parent shell)
// with values from .env so the live refresh and other config-driven features
// actually fire. Load the .env next to THIS file (not the process CWD) so the
// server boots correctly regardless of where it's launched from — e.g. a
// repo-root preview/launcher config, not only `cd backend && node server.js`.
// quiet: true — dotenv@17 otherwise prints a randomized third-party ad "tip"
// (see node_modules/dotenv/lib/main.js TIPS) on every boot; this app's own
// logging discipline is metadata-only, no unsolicited external URLs in logs.
dotenv.config({ override: false, quiet: true, path: fileURLToPath(new URL(".env", import.meta.url)) });
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// ── New architecture modules ──
import { enforceGates, TOPIC_TYPES } from "./policy-router.js";
import { runFAFSAEligibilityCheck, calculateDeadlineStatus } from "./rules-engine.js";
import { initFactStore, prepareFactStatements, seedCollegeFacts, searchFacts } from "./fact-store.js";
import {
  initEvidenceGraph,
  prepareEvidenceStatements,
  getEvidenceProfile,
  seedECBenchmarkEvidence,
  seedCollegeEvidence,
  seedCompetitiveActivityEvidence,
} from "./evidence-graph.js";
import "./answer-composer.js";
import { initPIIVault, preparePIIStatements } from "./pii-vault.js";
import { initUsageBudget, reserveBudget, reconcileBudget, releaseBudget } from "./usage-budget.js";
import {
  OPENROUTER_TARGETS,
  OPENROUTER_CATALOG,
  refreshOpenRouterTargets,
  refreshOpenRouterCatalog,
  configureOpenRouterCatalogCache,
} from "./openrouter-model-refresh.js";
import "./crimson-ec-exemplars.js";
import "./methodology.js";
import * as chatHistory from "./chat-history.js";
import { harvestEvidence } from "./ec-chat-evidence.js";
import { callLLM as adapterCallLLM, registerDynamicOpenRouterModels as adapterRegisterDynamicModels } from "./llm-adapters/index.js";
import "./content-moderation.js";
import { validateRequiredConsents } from "./consent.js";
import { initDomainMonitor, prepareMonitorStatements } from "./domain-monitor.js";
import {
  initCollegeResearch,
  readCachedDeadlines,
  pickScorecardHit,
  expandCollegeAlias,
  slugifyCollege,
} from "./college-research.js";
import "./fit-verifier.js";
import "./college-values.js";
import "./retention.js";
import { registerStandardJobs, registerJob, startAllJobs, stopAllJobs } from "./batch-jobs.js";
import { initVectorStore, prepareVectorStatements } from "./vector-store.js";
import "./source-registry.js";
import { initRAGTables, seedBaselines, prepareRAGStatements, extractGoalUnitIds } from "./rag-engine.js";
import { mountPillarRoutes } from "./server-routes-pillars.js";
import { removeStudentStorage } from "./student-storage.js";
import { refreshAllCds, shouldRunCdsRefresh } from "./cds-ingest-pipeline.js";
import "./ec-vectorizer.js";
import { seedAPConceptCatalog } from "./ap-concept-vectorizer.js";
import "./ap-concept-catalog.js";
import multer from "multer";
import { recomputeStudentECStrengthVectors, buildDefaultLLMClient, projectStrengthToLegacyVector } from "./ec-strength-vectorizer.js";
import "./competition-research.js";
import { getPrestigeExplanation } from "./friendly-labels.js";
// F6 uses the same major-bucket matcher as the EC vectorizer to score
// candidate EC ideas against the student's active narrative.
import { matchMajorBucket as matchMajorBucketFn } from "./ec-vectorizer.js";
import {
  saveNarrative,
  getActiveNarrative,
  computeProfileFingerprint,
  NARRATIVE_MIN_CHARS,
  NARRATIVE_MAX_CHARS,
} from "./narrative-store.js";
import { extractText, extractPdfOCR, isSupportedMime, MAX_FILE_BYTES } from "./file-extractors.js";
import "./transcript-import.js";
import { detectSchoolMentions, formatVerifiedDataBlock } from "./chat-grounding.js";
import * as chatGraph from "./chat-graph.js";
import {
  SCOUT_VERSION,
  initPolicyScout,
  preparePolicyScoutStatements,
  runPolicyScout,
  readPolicySnapshot,
  scoutSchool,
  snapshotAsDeadlineRecord,
  snapshotIsCurrent,
  formatPolicyLine,
  lastAutomaticRun,
} from "./admissions-policy-scout.js";
import { GPA_BASELINES, SAT_BASELINES, ACT_BASELINES, EC_BENCHMARKS, COLLEGE_PROFILES, COMPETITIVE_ACTIVITY_BENCHMARKS } from "./baseline-data.js";
import { searchScorecard, getCollegeById } from "./college-scorecard.js";
import { computeCdsQueryCacheKey, extractTargetSchoolNames, resolveAndParseCdsTargets } from "./cds-search.js";
import {
  ensureCdsStoreSeeded,
  resolveStoredCdsRecord,
  cdsRecordToPositioningResult,
  slugifySchoolName,
  isCdsRecordValidated,
  cdsVerification,
  strictSchoolKey,
  schoolNamesCompatible,
} from "./cds-store.js";
import {
  initAdmissionsIntelligenceTables,
  prepareAdmissionsIntelStatements,
  resolveIpedsGrowthForMajor,
  resolveMajorPolicyForSchool,
  resolveStrategicFocusForSchool,
  seedOfficialCipMappings,
} from "./admissions-intelligence.js";
import "./admissions-intelligence-loader.js";
import "./chat-envelope.js";
import {
  buildStudentModel,
  buildPositioningForTarget,
  buildProfileComparison,
  compareApExams,
  compareCourseRigor,
  compareGpaToSchool,
  compareRankToSchool,
  compareTestsToSchool,
} from "./positioning-engine.js";
import "./course-sequence-catalog.js";
import { loadOrchestrationCatalog, buildSystemPrompt } from "./orchestration-engine.js";
import "./i18n.js";
import { initAuthStore, isLoopbackAddress } from "./security-auth.js";
import {
  ADMIN_AUTH_RATE_LIMIT,
  AUTH_RATE_LIMIT,
  buildHealthResponse,
  securityResponseMiddleware,
  shouldUseSecureAdminCookie,
} from "./security-hardening.js";
import { OPENROUTER_MODEL_OPTIONS } from "./llm-adapters/tier-defaults.js";
import {
  initModelCatalogScout,
  prepareModelCatalogStatements,
  runModelCatalogScout,
  listDynamicModelOptions,
  dynamicAllowedModelIds,
  lastModelCatalogRun,
  MODEL_SCOUT_VERSION,
} from "./model-catalog-scout.js";
import { scoutCadenceMs, scoutRunDue, cadenceDays, SCOUT_DUE_CHECK_MS } from "./scout-cadence.js";
import "./web-secret-store.js";
import { registerMethodologyRoutes } from "./routes/methodology.js";
import { registerContextRoutes } from "./routes/context.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerCdsRoutes } from "./routes/cds.js";
import { registerAdmissionsPolicyRoutes } from "./routes/admissions-policy.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerStudentsRoutes } from "./routes/students.js";
import { registerCollegesRoutes } from "./routes/colleges.js";
import { registerRagRoutes } from "./routes/rag.js";
import { registerPositioningRoutes } from "./routes/positioning.js";
import { registerSimulationsRoutes } from "./routes/simulations.js";
import { registerEcRoutes } from "./routes/ec.js";
import { registerFilesRoutes } from "./routes/files.js";
import { registerNarrativeRoutes } from "./routes/narrative.js";
import { registerDirectionalityRoutes } from "./routes/directionality.js";
import { registerApConceptsRoutes } from "./routes/ap-concepts.js";
import { registerCoursesRoutes } from "./routes/courses.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerBaselinesRoutes } from "./routes/baselines.js";
import { registerConsentRoutes } from "./routes/consent.js";
import { registerAdmissionsIntelRoutes } from "./routes/admissions-intel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════
const PORT = parseInt(process.env.PORT || "3001", 10);
const WEB_DEPLOYMENT = process.env.WEB_DEPLOYMENT === "1";
const WEB_SECRETS_READY = !WEB_DEPLOYMENT || process.env.WEB_SECRETS_READY === "1";
const WEB_CONFIG_KEY = String(process.env.WEB_CONFIG_KEY || "");
const HOST = process.env.HOST || (WEB_DEPLOYMENT ? "0.0.0.0" : undefined);
// Installation-wide OpenRouter key. Students never supply provider keys or
// endpoints; every paid request uses this fixed provider boundary and is
// charged against the authenticated student's grade-based monthly budget.
function resolveOperatorLLM() {
  const orKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (orKey) return { provider: "openrouter", apiKey: orKey, baseUrl: "https://openrouter.ai/api/v1" };
  return null;
}
const OPERATOR_LLM = resolveOperatorLLM();
const ALLOWED_ORIGINS = [...new Set([
  ...(process.env.ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173,http://localhost:5180").split(","),
  process.env.PUBLIC_APP_URL || "",
].map((value) => value.trim().replace(/\/$/, "")).filter(Boolean))];
const NODE_ENV = process.env.NODE_ENV || "development";
// Treat an unfilled `.env.example` placeholder (REPLACE_WITH…) as unset, so a
// freshly-copied .env doesn't make the server think a bogus key is live data.
const SCORECARD_API_KEY = /^REPLACE_WITH/i.test(process.env.SCORECARD_API_KEY || "")
  ? ""
  : (process.env.SCORECARD_API_KEY || "");
// ── First-run setup (guarded operator endpoint, see /api/setup/*) ──
// A one-time token, regenerated every boot, gates the setup endpoint together
// with a loopback-only check. We only consider setup "available" (and only
// print the token) when something still needs configuring — a real
// ENCRYPTION_KEY from the environment, or a live Scorecard key. This keeps a
// fully-configured production boot quiet and the token out of its logs.
const FAFSA_GUIDANCE_PATH = process.env.FAFSA_GUIDANCE_PATH || path.join(__dirname, "data", "fafsa", "2026-2027.txt");
const ADMISSIONS_DEADLINES_PATH = process.env.ADMISSIONS_DEADLINES_PATH || path.join(__dirname, "data", "admissions-deadlines.json");
const RETENTION_MODE = process.env.RETENTION_MODE || "consumer"; // "consumer" or "institutional"
const SIM_URL = (process.env.SIM_URL || `http://127.0.0.1:${process.env.SIM_PORT || "3002"}`).replace(/\/$/, "");
const SIM_INTERNAL_TOKEN = process.env.SIM_INTERNAL_TOKEN || "local-simulation-sidecar";

// Email config

// Encryption key.
//   - Production: MUST come from the environment (enforced below).
//   - Development: prefer the env var; otherwise generate ONCE and
//     persist to a gitignored file so the SAME key is reused across
//     every backend restart. Previously the dev fallback generated a
//     fresh random key on every boot, which silently made all stored
//     PII (including the encrypted BYOK key) undecryptable after a
//     restart — forcing students to re-enter everything. Persisting
//     the key fixes that "re-login on every restart" problem at its
//     root.
function resolveEncryptionKey() {
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
  if (NODE_ENV === "production") {
    // Validated/fatal below — return a placeholder so this function
    // doesn't throw before that explicit check runs.
    return crypto.randomBytes(32).toString("hex");
  }
  // Dev: load-or-create a stable key on disk.
  const keyPath = path.join(__dirname, ".dev-encryption-key");
  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, "utf8").trim();
      if (/^[0-9a-fA-F]{64}$/.test(existing)) {
        console.log("[BOOT] Loaded persistent dev encryption key (.dev-encryption-key).");
        return existing;
      }
      console.warn("[BOOT] .dev-encryption-key is malformed — regenerating.");
    }
    const fresh = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(keyPath, fresh, { mode: 0o600 });
    console.log("[BOOT] Generated + persisted a new dev encryption key (.dev-encryption-key). Account data will now survive restarts.");
    return fresh;
  } catch (e) {
    console.warn("[BOOT] Could not persist dev encryption key — falling back to ephemeral key (data will NOT survive restart):", e.message);
    return crypto.randomBytes(32).toString("hex");
  }
}
const ENCRYPTION_KEY = resolveEncryptionKey();
chatHistory.configureChatEncryption(ENCRYPTION_KEY);

// ═══════════════════════════════════════════════════════════
// STARTUP VALIDATION
// ═══════════════════════════════════════════════════════════
if (!OPERATOR_LLM) {
  console.warn("[BOOT] No OpenRouter key is configured — paid AI features are disabled until the local administrator adds one.");
} else {
  console.log(`[BOOT] Operator LLM key configured (provider: ${OPERATOR_LLM.provider}).`);
}
if (!process.env.ENCRYPTION_KEY && NODE_ENV === "production") {
  console.error("FATAL: ENCRYPTION_KEY required in production.");
  process.exit(1);
}
if (!process.env.SIM_INTERNAL_TOKEN && NODE_ENV === "production") {
  console.error("FATAL: SIM_INTERNAL_TOKEN required in production for simulation sidecar proxying.");
  process.exit(1);
}
console.log(`[BOOT] Environment: ${NODE_ENV}`);
console.log(`[BOOT] Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
console.log(`[BOOT] Retention mode: ${RETENTION_MODE}`);
console.log(`[BOOT] College Scorecard API: ${SCORECARD_API_KEY ? "CONFIGURED" : "NOT CONFIGURED (offline mode)"}`);
// DATABASE INITIALIZATION — 3 physically separate databases
// ═══════════════════════════════════════════════════════════
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// 1. Operational DB (audit, baselines, snapshots, usage)
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "counselor.db");
const db = new Database(DB_PATH, { verbose: NODE_ENV === "development" ? console.log : undefined });
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
const authStore = initAuthStore(db);
initUsageBudget(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    user_hint TEXT,
    details TEXT,
    ip_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(type);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);

  CREATE TABLE IF NOT EXISTS notification_queue (
    id TEXT PRIMARY KEY,
    recipient_email_hash TEXT NOT NULL,
    recipient_email_encrypted TEXT NOT NULL,
    student_hint TEXT,
    notification_type TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notif_status ON notification_queue(status);

`);

// 2. PII Vault (separate encrypted DB)
const piiVault = initPIIVault(DATA_DIR, ENCRYPTION_KEY, NODE_ENV);
const piiStmts = preparePIIStatements(piiVault);

// 2a. Ensure the per-student budget cap column exists.

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 2b. OpenRouter live catalog refresh — fetch the full model list (ids,
//     pricing, context) at boot and every 24h. This drives the BYOK model
//     dropdown (GET /api/llm/openrouter/models) and budget pricing
//     (usage-budget.js). If OpenRouter is unreachable we keep the last-known
//     catalog and the static fallback list and retry next cycle.
// The catalog is also the budget tracker's price table, so an empty
// catalog means every model call is refused. A failed boot fetch now falls
// back to the last-known catalog on disk, retries every five minutes until
// OpenRouter answers, and the chat route triggers one refresh itself when
// it finds the catalog empty (see ensureOpenRouterCatalog).
configureOpenRouterCatalogCache(path.join(DATA_DIR, "openrouter-catalog.json"));
refreshOpenRouterCatalog()
  .then(() => maybeRunModelCatalogScout("boot", { refreshCatalog: false }).catch((err) => console.warn("[MODEL-SCOUT] boot run failed:", err?.message)))
  .catch(err => console.warn("[OR-CATALOG] Boot refresh threw:", err.message));
setInterval(() => {
  refreshOpenRouterCatalog().catch(err => console.warn("[OR-CATALOG] Daily refresh threw:", err.message));
}, REFRESH_INTERVAL_MS).unref();
setInterval(() => {
  if (OPENROUTER_CATALOG.reachable === true && OPENROUTER_CATALOG.models.length) return;
  refreshOpenRouterCatalog().catch(err => console.warn("[OR-CATALOG] Retry refresh threw:", err.message));
}, 5 * 60 * 1000).unref();

// 2c. OpenRouter recommended-model refresh — same 24h cadence, but migration
//     is PROPOSE-ONLY (human approval via the BYOK "Update models" prompt). No
//     student row is rewritten automatically for BYOK providers.
refreshOpenRouterTargets({ reason: "boot" }).catch(err => console.warn("[OR-MIGRATE] Boot refresh threw:", err.message));
setInterval(() => {
  refreshOpenRouterTargets({ reason: "daily" }).catch(err => console.warn("[OR-MIGRATE] Daily refresh threw:", err.message));
}, REFRESH_INTERVAL_MS).unref();

// 3. Vector Store (separate DB, no PII)
const vectorStore = initVectorStore(DATA_DIR, NODE_ENV);
const vectorStmts = prepareVectorStatements(vectorStore);

// ── Operational DB modules ──
initRAGTables(db);
// Model-catalog scout (every two weeks — see scout-cadence.js): newly listed
// OpenRouter chat models become extra per-tier options (and pass the adapter
// allowlist); the reviewed tier defaults never change on their own.
initModelCatalogScout(db);
const modelCatalogStmts = prepareModelCatalogStatements(db);
adapterRegisterDynamicModels(dynamicAllowedModelIds(modelCatalogStmts));
function runScheduledModelCatalogScout(trigger = "scheduled") {
  const summary = runModelCatalogScout({
    catalog: OPENROUTER_CATALOG,
    stmts: modelCatalogStmts,
    knownIds: new Set(OPENROUTER_MODEL_OPTIONS.map((o) => o.id)),
    trigger,
  });
  adapterRegisterDynamicModels(dynamicAllowedModelIds(modelCatalogStmts));
  console.log(`[MODEL-SCOUT] ${trigger}: ${summary.catalogCount} in catalog, ${summary.eligible} eligible, ${summary.added.length} new${summary.added.length ? ` (${summary.added.map((a) => `${a.id}→${a.tier}`).join(", ")})` : ""}${summary.pruned ? `, ${summary.pruned} removed` : ""}`);
  return summary;
}
// Every automatic scout shares one cadence — two weeks unless
// SCOUT_CADENCE_DAYS says otherwise. The hourly job and the boot hook run a
// scout only when its last completed run is that old; a counselor's manual
// run always goes ahead.
const SCOUT_CADENCE_MS = scoutCadenceMs();
const SCOUT_CADENCE_DAYS = cadenceDays(SCOUT_CADENCE_MS);
const MODEL_SCOUT_ENABLED = process.env.MODEL_SCOUT !== "0";
// A newer rule set (MODEL_SCOUT_VERSION) re-reads the catalog at once so
// the picker never keeps rows the current rules would reject.
function modelCatalogScoutSchedule(force = null) {
  const last = lastModelCatalogRun(modelCatalogStmts);
  const staleVersion = last && last.scoutVersion !== MODEL_SCOUT_VERSION ? "scout_version_changed" : null;
  return scoutRunDue({ lastRun: last, cadenceMs: SCOUT_CADENCE_MS, force: force || staleVersion });
}
async function maybeRunModelCatalogScout(trigger = "scheduled", { refreshCatalog = true, force = null } = {}) {
  if (!MODEL_SCOUT_ENABLED) return { skipped: "disabled" };
  const schedule = modelCatalogScoutSchedule(force);
  if (!schedule.due) return { skipped: schedule.reason, nextRunAt: schedule.nextRunAt };
  if (refreshCatalog) await refreshOpenRouterCatalog();
  return runScheduledModelCatalogScout(trigger);
}
initAdmissionsIntelligenceTables(db);
initFactStore(db);
initEvidenceGraph(db);
initDomainMonitor(db);

seedBaselines(db, { GPA_BASELINES, SAT_BASELINES, ACT_BASELINES, EC_BENCHMARKS, COLLEGE_PROFILES, COMPETITIVE_ACTIVITY_BENCHMARKS });
seedOfficialCipMappings(db);

const ragStmts = prepareRAGStatements(db);
// Thread graph: entity-keyed memory of earlier counseling turns, built when
// assistant turns are persisted and read by the chat route (chat-graph.js).
chatGraph.ensureChatGraphTables(db);
const chatGraphStmts = chatGraph.prepareChatGraphStatements(db);
const admissionsIntelStmts = prepareAdmissionsIntelStatements(db);

// Seed the cds_records table from the on-disk parsed/validated CDS cache so
// College Fit can ground its calculation in real C7 weights + admit rates
// instead of failing live fetches. Idempotent; only ingests when empty.
ensureCdsStoreSeeded(ragStmts)
  .then((r) => { if (r.seeded) console.log(`[cds-store] seeded ${r.ingested} CDS records (${r.errors?.length || 0} errors)`); })
  .catch((err) => console.warn("[cds-store] seed failed:", err.message));
const factStmts = prepareFactStatements(db);
const evidenceStmts = prepareEvidenceStatements(db);
const monitorStmts = prepareMonitorStatements(db);
const collegeResearchStmts = initCollegeResearch(db);
// The latest College Fit read per (student, school). Written by the fit
// routes, read by the chat so the counselor quotes the same label the card
// shows — and by the double-check, which attaches its verdict.
db.exec(`
  CREATE TABLE IF NOT EXISTS student_fit_reads (
    student_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    school TEXT NOT NULL,
    label TEXT,
    score REAL,
    admissibility REAL,
    competitiveness REAL,
    fit REAL,
    confidence TEXT,
    provenance_json TEXT,
    verification_json TEXT,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (student_id, slug)
  );
`);
const fitReadStmts = {
  upsert: db.prepare(`
    INSERT INTO student_fit_reads (student_id, slug, school, label, score, admissibility, competitiveness, fit, confidence, provenance_json, verification_json, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, slug) DO UPDATE SET
      school = excluded.school, label = excluded.label, score = excluded.score,
      admissibility = excluded.admissibility, competitiveness = excluded.competitiveness, fit = excluded.fit,
      confidence = excluded.confidence, provenance_json = excluded.provenance_json,
      verification_json = COALESCE(excluded.verification_json, student_fit_reads.verification_json),
      computed_at = excluded.computed_at`),
  byStudent: db.prepare("SELECT * FROM student_fit_reads WHERE student_id = ?"),
};
function rememberFitRead(studentId, target, { verification = null } = {}) {
  try {
    const slug = slugifyCollege(target?.schoolName || "");
    if (!slug) return;
    fitReadStmts.upsert.run(
      studentId, slug, target.schoolName, target.overallPositioningLabel || null, target.finalPositioningScore ?? null,
      target.admissibility?.academicReadinessScore ?? null, target.competitiveness?.majorCompetitivenessScore ?? null,
      target.fit?.institutionalPriorityFitScore ?? null, target.confidence?.evidenceConfidence || null,
      JSON.stringify(target.dataProvenance || null), verification ? JSON.stringify(verification) : null,
      new Date().toISOString(),
    );
  } catch (err) { console.warn("[fit-read] not saved:", err?.message); }
}
function fitReadsForStudent(studentId) {
  try {
    return fitReadStmts.byStudent.all(studentId).map((row) => ({
      school: row.school, slug: row.slug, label: row.label, score: row.score,
      admissibility: row.admissibility, competitiveness: row.competitiveness, fit: row.fit,
      confidence: row.confidence, provenance: safeParseJSON(row.provenance_json, null),
      verification: safeParseJSON(row.verification_json, null), computedAt: row.computed_at,
    }));
  } catch { return []; }
}

initPolicyScout(db);
const policyScoutStmts = preparePolicyScoutStatements(db);

// Seed fact store and evidence graph from baseline data
seedCollegeFacts(factStmts, COLLEGE_PROFILES, db);
seedECBenchmarkEvidence(evidenceStmts, EC_BENCHMARKS, db);
seedCollegeEvidence(evidenceStmts, COLLEGE_PROFILES, db);
seedCompetitiveActivityEvidence(evidenceStmts, COMPETITIVE_ACTIVITY_BENCHMARKS, db);

// Seed AP concept catalog mirror (idempotent). Per-student concept rows
// remain lazy — they are only created when the student's own prompts/files
// reference the subject.
try {
  const seeded = seedAPConceptCatalog(ragStmts.apConcepts);
  console.log(`[RAG] AP concept catalog seeded: ${seeded} concepts`);
} catch (err) {
  console.error("[RAG] AP concept catalog seeding failed:", err);
}

const orchestrationCatalog = loadOrchestrationCatalog({
  fafsaPath: FAFSA_GUIDANCE_PATH,
  deadlinesPath: ADMISSIONS_DEADLINES_PATH,
});

// ── Prepared statements for audit/notification ──
const stmts = {
  insertAudit: db.prepare(`INSERT INTO audit_events (id, timestamp, type, user_hint, details, ip_hash) VALUES (?, ?, ?, ?, ?, ?)`),
  insertNotification: db.prepare(`INSERT INTO notification_queue (id, recipient_email_hash, recipient_email_encrypted, student_hint, notification_type, message, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`),
  updateNotificationStatus: db.prepare(`UPDATE notification_queue SET status = ?, sent_at = datetime('now'), error = ? WHERE id = ?`),
  getPendingNotifications: db.prepare(`SELECT * FROM notification_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10`),
  getAuditEvents: db.prepare(`SELECT id, timestamp, type, user_hint, details FROM audit_events ORDER BY timestamp DESC LIMIT ? OFFSET ?`),
  getAuditByType: db.prepare(`SELECT id, timestamp, type, user_hint, details FROM audit_events WHERE type = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`),
  getCrisisCount24h: db.prepare(`SELECT COUNT(*) as count FROM audit_events WHERE type = 'crisis_detected' AND timestamp >= datetime('now', '-24 hours')`),
  getAuditStats: db.prepare(`SELECT type, COUNT(*) as count FROM audit_events WHERE timestamp >= datetime('now', '-7 days') GROUP BY type ORDER BY count DESC`),
  cleanOldAudit: db.prepare(`DELETE FROM audit_events WHERE timestamp < datetime('now', '-90 days')`),
  cleanOldNotifications: db.prepare(`DELETE FROM notification_queue WHERE created_at < datetime('now', '-90 days')`),
};

// ═══════════════════════════════════════════════════════════
// BATCH JOBS — scheduled background tasks
// ═══════════════════════════════════════════════════════════
registerStandardJobs({
  db,
  piiVault,
  factStmts,
  piiStmts,
  monitorStmts,
  retentionMode: RETENTION_MODE,
});

// Opt-in auto-refresh of Common Data Set records (the daily domain_monitor
// already watches official pages; this re-ingests the newest registered CDS
// cycle). OFF by default because it does network I/O across many schools —
// enable with AUTO_REFRESH_CDS=1, tune cycle via CDS_REFRESH_CYCLE. Only
// data from operator-registered authoritative CDS links is ingested; nothing
// is fabricated. AP concept data is a curated catalog (no live source).
if (process.env.AUTO_REFRESH_CDS === "1") {
  const CDS_CYCLE = process.env.CDS_REFRESH_CYCLE || "2024-25";
  registerJob("cds_refresh", async () => {
    const { ingestBulk, getRepositoryIndex } = await import("./cds-ingest-pipeline.js");
    const index = await getRepositoryIndex();
    const targets = index.map((e) => e.name).filter(Boolean);
    if (!targets.length) return;
    console.log(`[CDS-REFRESH] Auto-refreshing ${targets.length} school(s) to cycle ${CDS_CYCLE}…`);
    const results = await ingestBulk(ragStmts, targets, { concurrency: 2, year: CDS_CYCLE });
    const ok = results.filter((r) => r.status === "ok" || r.status === "ok_with_overrides").length;
    console.log(`[CDS-REFRESH] Done: ${ok}/${results.length} ingested.`);
  }, 7 * 24 * 60 * 60 * 1000, { runOnStartup: false }); // weekly
  console.log(`[BOOT] AUTO_REFRESH_CDS enabled — weekly CDS re-ingest for cycle ${process.env.CDS_REFRESH_CYCLE || "2024-25"}.`);
}

// Daily CDS web-scrape from June 1 onward. New Common Data Sets publish across
// the summer, so from June 1 through year-end we re-scrape the repository index
// and re-ingest every school each day, preferring the newest cycle — keeping
// College Fit grounded in the freshest CDS. Deterministic parse (no LLM/key).
// Enabled by default; set CDS_DAILY_REFRESH=0 to disable.
if (process.env.CDS_DAILY_REFRESH !== "0") {
  registerJob("cds_daily_refresh", async () => {
    if (!shouldRunCdsRefresh(Date.now())) return { skipped: "before June 1 (off-season)" };
    const concurrency = Number(process.env.CDS_REFRESH_CONCURRENCY || 3) || 3;
    const r = await refreshAllCds(ragStmts, { concurrency });
    console.log(`[BATCH] cds_daily_refresh: ${r.total} schools`, JSON.stringify(r.byStatus));
    // Every record the refresh refused to overwrite goes to the audit log,
    // one event per school, so the counselor's log shows what needs a look.
    for (const held of r.heldBack || []) {
      console.warn(`[BATCH] cds_daily_refresh held back ${held.slug} (${held.year} over stored ${held.storedYear}): ${held.reasons.join("; ")}`);
      try { stmts.insertAudit.run(crypto.randomUUID(), new Date().toISOString(), "cds_refresh_held_back", held.slug.slice(0, 12), `${held.slug} ${held.year} over ${held.storedYear}: ${held.reasons.join("; ")}`.slice(0, 500), null); } catch (err) { console.warn("[BATCH] audit write failed:", err.message); }
    }
    return { changed: true, ...r };
  }, 24 * 60 * 60 * 1000, { enabled: true, runOnStartup: false });
  console.log("[BOOT] CDS daily refresh scheduled (active June 1+; CDS_DAILY_REFRESH=0 to disable).");
}

// Automatic scouts run every two weeks (SCOUT_CADENCE_DAYS overrides). A
// deploy restarts every timer, so instead of a two-week setInterval each
// scout is checked hourly against its last completed run in the database
// and runs once the cadence has elapsed — the same check runs shortly after
// boot. Manual runs from the admin page never wait.
//   • admissions_policy_scout — reads each tracked school's own admissions
//     pages (test policy, plan deadlines, application fee), logs what
//     changed, and refreshes the verified facts the chat and calendar read.
//     Deterministic — no model, no key. POLICY_SCOUT=0 disables it.
//   • model_catalog_scout — refreshes the OpenRouter catalog, then lists any
//     new eligible models as per-tier options for the counselor to pick
//     from. MODEL_SCOUT=0 disables it.
if (process.env.POLICY_SCOUT !== "0") {
  registerJob("admissions_policy_scout", () => maybeRunPolicyScout("scheduled"), SCOUT_DUE_CHECK_MS, { enabled: true, runOnStartup: false });
  if (process.env.NODE_ENV !== "test") {
    const bootDelay = Number(process.env.POLICY_SCOUT_BOOT_DELAY_MS) > 0 ? Number(process.env.POLICY_SCOUT_BOOT_DELAY_MS) : 5 * 60 * 1000;
    setTimeout(() => {
      maybeRunPolicyScout("boot").catch((err) => console.warn("[policy-scout] boot run failed:", err?.message));
    }, bootDelay).unref();
  }
  console.log(`[BOOT] Admissions-policy scout scheduled every ${SCOUT_CADENCE_DAYS} day(s), checked hourly (POLICY_SCOUT=0 to disable).`);
}
if (MODEL_SCOUT_ENABLED) {
  registerJob("model_catalog_scout", () => maybeRunModelCatalogScout("scheduled"), SCOUT_DUE_CHECK_MS, { enabled: true, runOnStartup: false });
  console.log(`[BOOT] Model-catalog scout scheduled every ${SCOUT_CADENCE_DAYS} day(s), checked hourly (MODEL_SCOUT=0 to disable).`);
}

startAllJobs();

// ═══════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════
// In-memory hot cache backed by a persistent SQLite table. Tokens
// used to live ONLY in this Map, which meant every backend restart
// (deploy, crash, `node --watch` reload) silently invalidated every
// active session — the browser still held a token the server no
// longer recognized, surfacing as "Invalid or expired session token"
// on the next call. Persisting to SQLite makes sessions survive
// restarts; the Map stays as a fast read path.
const sessionTokens = new Map();
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (was 1 hour)

// Persistent store. Token is hashed before storage so a DB leak
// doesn't hand out live bearer tokens.
db.exec(`
  CREATE TABLE IF NOT EXISTS session_tokens (
    token_hash   TEXT PRIMARY KEY,
    email_hash   TEXT NOT NULL,
    student_id   TEXT NOT NULL,
    expires_at   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_expires ON session_tokens(expires_at);
`);
const sessionStmts = {
  insert: db.prepare(`INSERT OR REPLACE INTO session_tokens (token_hash, email_hash, student_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`),
  get:    db.prepare(`SELECT email_hash, student_id, expires_at FROM session_tokens WHERE token_hash = ?`),
  touch:  db.prepare(`UPDATE session_tokens SET expires_at = ? WHERE token_hash = ?`),
  del:    db.prepare(`DELETE FROM session_tokens WHERE token_hash = ?`),
  cleanup:db.prepare(`DELETE FROM session_tokens WHERE expires_at < ?`),
};

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createSessionToken(emailHash, studentId) {
  return authStore.issueStudentSession(emailHash, studentId);
}

function validateTokenLegacy(token) {
  if (!token) return null;
  const now = Date.now();
  // 1) Fast path — in-memory hot cache.
  let session = sessionTokens.get(token);
  if (session) {
    if (now > session.expiresAt) { sessionTokens.delete(token); try { sessionStmts.del.run(hashToken(token)); } catch {} return null; }
    session.expiresAt = now + TOKEN_TTL_MS;
    try { sessionStmts.touch.run(session.expiresAt, hashToken(token)); } catch {}
    return session;
  }
  // 2) Cold path — survived a restart, look it up in SQLite and
  //    re-hydrate the Map. This is what fixes "Invalid or expired
  //    session token" after a backend restart.
  try {
    const row = sessionStmts.get.get(hashToken(token));
    if (!row) return null;
    if (now > row.expires_at) { sessionStmts.del.run(hashToken(token)); return null; }
    const rehydrated = { emailHash: row.email_hash, studentId: row.student_id, expiresAt: now + TOKEN_TTL_MS };
    sessionTokens.set(token, rehydrated);
    sessionStmts.touch.run(rehydrated.expiresAt, hashToken(token));
    return rehydrated;
  } catch (e) {
    console.warn("[SESSION] DB lookup failed:", e.message);
    return null;
  }
}

function validateToken(token) {
  return authStore.validateStudentSession(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessionTokens) {
    if (now > session.expiresAt) sessionTokens.delete(token);
  }
  try { sessionStmts.cleanup.run(now); } catch {}
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
// CRYPTO HELPERS
// ═══════════════════════════════════════════════════════════
function hashIP(ip) {
  return crypto.createHash("sha256").update(`ip_salt_cc:${ip}`).digest("hex").slice(0, 16);
}

function hashEmail(email) {
  return crypto.createHash("sha256").update(`email_salt_cc:${email.toLowerCase().trim()}`).digest("hex");
}

function encryptValue(plaintext) {
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

function decryptValue(blob) {
  try {
    const [ivHex, tagHex, encrypted] = blob.split(":");
    const key = Buffer.from(ENCRYPTION_KEY, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}

function safeJSON(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; }
  catch { return fallback; }
}

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════
function requireStudentAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Student session token required. Include Authorization: Bearer <token>" });
  }
  const session = validateToken(auth.split(" ")[1]);
  if (!session) return res.status(401).json({ error: "Invalid or expired session token." });
  req.studentEmailHash = session.emailHash;
  req.studentId = session.studentId;
  next();
}

function requireSelf(req, res, next) {
  const requestedId = req.params?.id || req.params?.studentId || req.body?.student_id || req.query?.student_id;
  if (requestedId && requestedId !== req.studentId) {
    return res.status(403).json({ error: "Access denied", code: "student_scope_mismatch" });
  }
  next();
}

function bearerToken(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

function readCookie(req, name) {
  const cookieHeader = String(req.headers.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return "";
}

const ADMIN_COOKIE = "cc_admin_session";

function setAdminCookie(req, res, token) {
  const secure = shouldUseSecureAdminCookie({ requestSecure: req.secure, webDeployment: WEB_DEPLOYMENT }) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=604800${secure}`);
}

function clearAdminCookie(req, res) {
  const secure = shouldUseSecureAdminCookie({ requestSecure: req.secure, webDeployment: WEB_DEPLOYMENT }) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure}`);
}

function isAllowedRequestOrigin(req) {
  const origin = String(req.headers.origin || "").replace(/\/$/, "");
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (NODE_ENV !== "production" && LOCALHOST_ORIGIN_RE.test(origin)) return true;
  if (WEB_DEPLOYMENT) {
    const sameOrigin = `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
    return origin === sameOrigin;
  }
  return false;
}

function hasAllowedAdminOrigin(req) {
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!req.headers.origin && mutating && NODE_ENV === "production") return false;
  return isAllowedRequestOrigin(req);
}

function hasDesktopBootstrapProof(req) {
  const expected = String(WEB_DEPLOYMENT
    ? process.env.WEB_ADMIN_BOOTSTRAP_TOKEN
    : process.env.DESKTOP_BOOTSTRAP_TOKEN || "");
  if (!expected) return NODE_ENV !== "production";
  const received = String(req.headers[WEB_DEPLOYMENT ? "x-web-setup-token" : "x-desktop-bootstrap"] || "");
  const actualHash = crypto.createHash("sha256").update(received).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function requireAdminNetwork(req, res, next) {
  if (!WEB_DEPLOYMENT && !isLoopbackAddress(req.socket?.remoteAddress)) {
    return res.status(403).json({ error: "Administrator access is local-only." });
  }
  next();
}

function requireCounselorAuth(req, res, next) {
  if (!WEB_DEPLOYMENT && !isLoopbackAddress(req.socket?.remoteAddress)) {
    return res.status(403).json({ error: "Administrator access is local-only." });
  }
  if (!hasAllowedAdminOrigin(req)) {
    return res.status(403).json({ error: "Administrator origin is not allowed." });
  }
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!authStore.validateAdminSession(
    readCookie(req, ADMIN_COOKIE),
    req.headers["x-csrf-token"],
    mutating,
  )) {
    return res.status(401).json({ error: "Administrator session required." });
  }
  next();
}

function snapshotToStudentProfile(snapshot, narrative = null) {
  return {
    gpa: { unweighted: snapshot.gpa_unweighted, weighted: snapshot.gpa_weighted },
    classRank: safeJSON(snapshot.class_rank_json, null),
    courses: safeJSON(snapshot.courses_json, []),
    apScores: safeJSON(snapshot.ap_scores_json, []),
    testScores: safeJSON(snapshot.test_scores_json, []),
    activities: safeJSON(snapshot.activities_json, []),
    goals: safeJSON(snapshot.goals_json, []),
    majorInterest: snapshot.major_interest,
    narrative: narrative?.narrativeText || null,
  };
}

async function callSimulationSidecar(pathname, options = {}) {
  const response = await fetch(`${SIM_URL}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "x-simulation-internal-token": SIM_INTERNAL_TOKEN,
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(data?.error || `Simulation sidecar returned ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

// ─── Prestige adapter resolver ──────────────────────────────
// Prestige web-research is currently disabled: this returns null, so
// competition-research.js short-circuits to source:"unavailable" and the EC
// vectorizer falls back to deterministic signals (catalog / benchmark). Re-
// enabling web-enriched prestige on OpenRouter's web plugin is a tracked
// follow-up.
function resolvePrestigeAdapter(_studentId) {
  return null;
}

// ───────────────────────────────────────────────────────────
// Shared per-student paid-call closure. The installation-wide OpenRouter key
// is fixed by the local administrator; the student identity is used only for
// budget reservation, reconciliation, and the usage ledger.
// ───────────────────────────────────────────────────────────
function estimateModelInputTokens(system, messages) {
  const chars = String(system || "").length + JSON.stringify(messages || []).length;
  return Math.max(256, Math.min(100_000, Math.ceil(chars / 4)));
}

function reserveStudentModelCall(studentId, model, { system, messages, maxTokens, requestId } = {}) {
  const grade = authStore.getStudentGrade(studentId);
  const reservation = reserveBudget(db, {
    studentId,
    grade,
    requestId: requestId || crypto.randomUUID(),
    model,
    maxInputTokens: estimateModelInputTokens(system, messages),
    maxOutputTokens: Math.max(1, Math.min(Number(maxTokens) || 1024, MAX_TOKENS_LIMIT)),
  });
  if (!reservation.allowed) {
    const error = new Error(reservation.reason || "Monthly model budget does not allow this request.");
    error.status = 402;
    error.code = reservation.code || "budget_exceeded";
    error.budget = reservation;
    throw error;
  }
  if (reservation.idempotent) {
    const error = new Error("This request_id has already been reserved or processed.");
    error.status = 409;
    error.code = "duplicate_request_id";
    throw error;
  }
  return reservation;
}

function reconcileStudentModelCall(reservation, usage) {
  return reconcileBudget(db, {
    reservationId: reservation.reservationId,
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
  });
}

function releaseStudentModelCall(reservation) {
  if (reservation?.reservationId) releaseBudget(db, { reservationId: reservation.reservationId });
}

function currentOperatorKeyConfig() {
  return OPERATOR_LLM ? {
    provider: "openrouter",
    apiKey: OPERATOR_LLM.apiKey,
    models: { ...OPENROUTER_TARGETS },
  } : null;
}

function buildStudentCallLLM(studentId, { requestIdPrefix = null } = {}) {
  const operator = currentOperatorKeyConfig();
  if (!operator) return { modelConfig: null, callLLM: null };
  let callIndex = 0;
  const callLLM = async (args = {}) => {
    const model = args.model || operator.models.medium;
    const maxTokens = Math.max(1, Math.min(Number(args.max_tokens ?? args.maxTokens) || 1024, MAX_TOKENS_LIMIT));
    const requestId = String(args.requestId || (requestIdPrefix
      ? requestIdPrefix + ":" + (++callIndex)
      : crypto.randomUUID()));
    const reservation = reserveStudentModelCall(studentId, model, {
      system: args.system,
      messages: args.messages,
      maxTokens,
      requestId,
    });
    try {
      const result = await adapterCallLLM({
        provider: "openrouter",
        apiKey: operator.apiKey,
        model,
        maxTokens,
        system: args.system,
        messages: args.messages,
        temperature: typeof args.temperature === "number" ? args.temperature : undefined,
        signal: args.signal,
      });
      const budget = reconcileStudentModelCall(reservation, result?.usage);
      try {
        ragStmts.insertUsage.run(
          studentId,
          "openrouter:" + model,
          result?.usage?.input_tokens || 0,
          result?.usage?.output_tokens || 0,
          "administrator",
        );
      } catch { /* usage ledger is authoritative */ }
      return { ...result, _budget: budget };
    } catch (error) {
      releaseStudentModelCall(reservation);
      throw error;
    }
  };
  return { modelConfig: operator, callLLM };
}

// The only question the gate still refuses is a pure lookup — an exact
// date or admissions figure — about a named school we hold nothing for,
// after an on-demand read of the official source has been tried. The reply
// says what is missing, gives the typical window as general guidance, and
// points at the official page; it never quotes an unsourced figure.
function noSourceLookupMessage({ subIntent, school, locale, onDemand }) {
  const dates = String(subIntent || "").includes("deadline");
  const tried = onDemand === "failed" || onDemand === "timeout" || onDemand === "error";
  if (locale === "ko") {
    const s = school || "그 학교";
    const head = dates
      ? `${s}의 확인된 지원 마감일 자료가 아직 없어서 날짜를 추측해 드리지 않겠습니다. 미국 대학의 조기 전형(ED/EA) 마감은 대체로 11월 1일~15일, 정시(RD)는 1월 1일~15일 사이입니다. 정확한 날짜는 ${s}의 공식 입학처 페이지에서 확인하세요.`
      : `${s}의 확인된 입학 통계 자료가 아직 없어서 합격률이나 점수 범위를 추측해 드리지 않겠습니다. 공식 수치는 College Scorecard(collegescorecard.ed.gov)와 ${s}의 Common Data Set에서 확인할 수 있습니다.`;
    return head + (tried ? " 방금 공식 페이지를 직접 읽어 보려 했지만 가져오지 못했습니다. 잠시 후 다시 물어보거나 사이트에서 직접 확인해 주세요." : "");
  }
  const s = school || "that school";
  const head = dates
    ? `I don't have verified application dates for ${s} yet, so I won't guess a deadline. Most Early Decision and Early Action deadlines fall between November 1 and November 15, and Regular Decision between January 1 and January 15; confirm ${s}'s exact dates on its official admissions page.`
    : `I don't have verified admissions statistics for ${s} yet, so I won't quote an acceptance rate or score range I can't source. The College Scorecard (collegescorecard.ed.gov) and ${s}'s Common Data Set publish the official figures.`;
  return head + (tried ? ` I just tried to read ${s}'s official pages and couldn't reach them — ask again in a moment, or check the site directly.` : "");
}

function regulatedChatGate(classification, studentId, userText, locale, { schoolNamed, schoolName = null, onDemand = null } = {}) {
  const tt = classification?.topicType;
  if (tt !== TOPIC_TYPES.REGULATED && tt !== TOPIC_TYPES.HIGH_STAKES) return {};
  let evidence = [];
  try {
    const facts = searchFacts(factStmts, userText || "", 10) || [];
    const ev = studentId ? getEvidenceProfile(evidenceStmts, "student", studentId) : null;
    evidence = [...facts, ...((ev && ev.items) || [])];
  } catch { /* no evidence → the gate decides on the question alone */ }
  const gate = enforceGates(tt, classification.subIntent, evidence, { query: userText, schoolNamed });
  if (!gate.allowed) {
    const msg = noSourceLookupMessage({ subIntent: classification.subIntent, school: schoolName, locale, onDemand });
    const source = gate.fallback?.suggestedSource || null;
    return {
      block: true,
      response: {
        answer: msg,
        claims: [],
        limitations: [locale === "ko" ? "확인된 공식 출처가 없는 수치는 제시하지 않습니다." : "No figure is quoted without a verified official source."],
        actions: source?.url ? [{ label: source.label, url: source.url }] : [],
        usage: { input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 },
        content: [{ type: "text", text: msg }],
        _meta: { deterministic: true, topicType: tt, gates: gate.gates, modelTier: "NONE", noVerifiedSource: true, onDemandRead: onDemand },
      },
    };
  }
  return { systemPrefix: buildSystemPrompt(classification) };
}

// On-demand official reads for a pure lookup about a school we hold nothing
// for: the school's own admissions pages (the policy scout's reader, which
// also stores the snapshot for later turns) or the College Scorecard for
// admissions statistics. Bounded so a slow site cannot stall the chat; a
// read that outlives the wait finishes in the background.
const onDemandScouts = new Map();
async function scoutSchoolOnDemand(schoolName, { timeoutMs = 15_000 } = {}) {
  const row = resolveBaselineCollegeRow(db, { schoolName });
  const target = { name: row?.name || schoolName, unitId: row?.unit_id || null, website: row?.website || null };
  const key = slugifyCollege(target.name) || String(target.name).toLowerCase();
  if (!onDemandScouts.has(key)) {
    const run = scoutSchool(target, { stmts: policyScoutStmts, factStmts, scorecardKey: SCORECARD_API_KEY || null })
      .catch((err) => { console.warn("[policy-scout] on-demand read failed:", err?.message); return { status: "error" }; })
      .finally(() => onDemandScouts.delete(key));
    onDemandScouts.set(key, run);
  }
  const result = await Promise.race([
    onDemandScouts.get(key),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref()),
  ]);
  if (!result) return "timeout";
  if (["skipped", "failed", "error"].includes(result.status)) return result.status;
  return "ok";
}

async function scorecardStatsOnDemand(schoolName) {
  if (!SCORECARD_API_KEY) return null;
  try {
    const wanted = expandCollegeAlias(schoolName);
    const hit = pickScorecardHit((await searchScorecard(SCORECARD_API_KEY, { name: wanted, limit: 20 }))?.results, wanted);
    if (!hit) return null;
    const parts = [];
    const rate = Number(hit.acceptanceRate);
    if (Number.isFinite(rate) && rate > 0) parts.push(`admission rate ${Math.round(rate <= 1 ? rate * 100 : rate)}%`);
    if (hit.sat25 && hit.sat75) parts.push(`SAT middle 50% ${hit.sat25}–${hit.sat75}`);
    if (hit.act25 && hit.act75) parts.push(`ACT middle 50% ${hit.act25}–${hit.act75}`);
    if (!parts.length) return null;
    return {
      message: `${hit.name || wanted} — College Scorecard (U.S. Department of Education, latest reported year): ${parts.join("; ")}.`,
      source_url: "https://collegescorecard.ed.gov/",
      source_title: "College Scorecard (U.S. Department of Education)",
      confidence: "verified",
      trust_level: "official",
      advisory: "These are the latest figures the Department of Education reports; the school's own Common Data Set may be a year newer.",
    };
  } catch (err) {
    console.warn("[chat] Scorecard lookup failed:", err?.message);
    return null;
  }
}

// Parse the latest profile snapshot into a clean object for LLM prompts.
// PII-light: names/descriptions of the student's OWN activities/courses are
// their own data (no third-party PII); paid calls use the administrator's
// fixed OpenRouter key and the student's monthly budget ledger.
function assembleProfileForGeneration(studentId) {
  const snap = ragStmts.getLatestSnapshot.get(studentId);
  if (!snap) return null;
  const profile = snap.profile_json ? safeParseJSON(snap.profile_json, {}) : {};
  return {
    gpaUnweighted: snap.gpa_unweighted ?? profile?.gpa?.unweighted ?? null,
    gpaWeighted: snap.gpa_weighted ?? profile?.gpa?.weighted ?? null,
    classRank: safeParseJSON(snap.class_rank_json, null),
    courses: safeParseJSON(snap.courses_json, []),
    apScores: safeParseJSON(snap.ap_scores_json, []),
    testScores: safeParseJSON(snap.test_scores_json, []),
    activities: safeParseJSON(snap.activities_json, []),
    majorInterest: snap.major_interest || profile?.majorInterest || null,
    goals: safeParseJSON(snap.goals_json, []),
  };
}

// The student's record against one school's enrolled class — the same
// reads the College Fit calculation makes (tests by section, GPA, class
// rank, AP exams) from the stored Common Data Set and baseline row, with no
// live fetch — so the priorities matrix under the fit card can place a
// score against the school's middle 50% instead of only listing it. Null
// when nothing is held for the school.
function profileComparisonForSchool(studentId, schoolName) {
  try {
    if (!schoolName) return null;
    const snap = ragStmts.getLatestSnapshot.get(studentId);
    if (!snap) return null;
    const wanted = expandCollegeAlias(String(schoolName));
    const collegeRow = resolveBaselineCollegeRow(db, { schoolName: wanted });
    const record = resolveStoredCdsRecord(ragStmts, { schoolName: collegeRow?.name || wanted });
    if (!record && !collegeRow) return null;
    // A usable record (validated, or the school's own current document
    // reading consistently) supplies the numbers; only an externally
    // checked one counts as verified for the confidence read.
    const validated = record ? isCdsRecordValidated(ragStmts, record.slug) : false;
    const verification = record ? cdsVerification(ragStmts, record.slug) : "unverified";
    const cds = record ? cdsRecordToPositioningResult(record, { validated: verification === "validated", verification }) : null;
    const pick = (cdsVal, baseVal) => (record && validated ? (cdsVal ?? baseVal) : (baseVal ?? cdsVal));
    const college = {
      name: collegeRow?.name || record?.school || wanted,
      sat25: pick(record?.enrolledSAT?.p25, collegeRow?.sat_25) ?? null,
      sat75: pick(record?.enrolledSAT?.p75, collegeRow?.sat_75) ?? null,
      act25: pick(record?.enrolledACT?.p25, collegeRow?.act_25) ?? null,
      act75: pick(record?.enrolledACT?.p75, collegeRow?.act_75) ?? null,
      avgGpaAdmitted: pick(record?.enrolledGPA?.avg, collegeRow?.avg_gpa_admitted) ?? cds?.parsed?.gpaAverage ?? null,
    };
    const strengthRows = ragStmts.strength.getByStudent.all(studentId);
    const student = buildStudentModel({
      gpa_unweighted: snap.gpa_unweighted,
      gpa_weighted: snap.gpa_weighted,
      courses_json: snap.courses_json,
      test_scores_json: snap.test_scores_json,
      ap_scores_json: snap.ap_scores_json,
      class_rank_json: snap.class_rank_json,
      activities_json: snap.activities_json,
      major_interest: snap.major_interest,
    }, strengthRows, getActiveNarrative(ragStmts.narrative, studentId));
    const gpa = compareGpaToSchool(student, college, cds);
    return buildProfileComparison({
      tests: compareTestsToSchool(student, college, cds),
      gpa,
      classRank: compareRankToSchool(student, cds),
      apExams: compareApExams(student),
      rigor: compareCourseRigor(student, gpa.average),
    });
  } catch (err) {
    console.warn("[COLLEGE-VALUES] profile comparison skipped:", err?.message);
    return null;
  }
}

// What the priorities matrix reads beyond courses and activities: the
// student's EC strength vectors (the character profile of each activity)
// and the placement of their scores against this school.
function fitMatrixOptions(studentId, schoolName) {
  let strengthRows = [];
  try { strengthRows = ragStmts.strength.getByStudent.all(studentId) || []; } catch { strengthRows = []; }
  return { strengthRows, comparison: profileComparisonForSchool(studentId, schoolName), schoolName: schoolName || null };
}

// Names of every baseline college, cached for the per-turn school-mention
// scan (the table only changes at boot).
let baselineNameCache = { at: 0, names: [] };
function baselineCollegeNames() {
  if (Date.now() - baselineNameCache.at > 10 * 60 * 1000) {
    try {
      baselineNameCache = { at: Date.now(), names: db.prepare("SELECT name FROM baseline_colleges").all().map((r) => r.name) };
    } catch {
      baselineNameCache = { at: Date.now(), names: [] };
    }
  }
  return baselineNameCache.names;
}

// The VERIFIED DATA block for a chat turn, from local data only — no live
// Scorecard or CDS fetches (those belong to College Fit, where the latency is
// expected). Schools named in the question come first; the student's target
// schools are added for college-fit / strategy / supervisor calls.
function buildVerifiedDataContext({ questionText, studentId, evidence = [], wantsCollegeData = false }) {
  const knownNames = [...baselineCollegeNames(), ...fitReadsForStudent(studentId).map((r) => r.school)];
  const names = detectSchoolMentions(questionText, { knownNames });
  if (wantsCollegeData) {
    for (const target of resolveTargetSchools(studentId)) {
      const canonical = detectSchoolMentions(target, { knownNames, max: 1 })[0] || target;
      if (!names.some((n) => schoolNamesCompatible(n, canonical))) names.push(canonical);
    }
  }
  const schools = [];
  const fitReads = fitReadsForStudent(studentId);
  for (const name of names.slice(0, 8)) {
    const row = resolveBaselineCollegeRow(db, { schoolName: name });
    const cds = resolveStoredCdsRecord(ragStmts, { schoolName: row?.name || name });
    const fitRead = fitReads.find((r) => schoolNamesCompatible(r.school, row?.name || name)) || null;
    // A school known only through the policy scout — typically an on-demand
    // read of its admissions pages for a deadline question — still has
    // verified data worth citing (its plan deadlines and test policy).
    let snapshot = null;
    try { snapshot = readPolicySnapshot(policyScoutStmts, { unitId: row?.unit_id, name: row?.name || cds?.school || name }); } catch { snapshot = null; }
    if (!row && !cds && !fitRead && !snapshot) continue;
    const resolvedName = row?.name || cds?.school || fitRead?.school || snapshot?.school || name;
    if (schools.some((s) => schoolNamesCompatible(s.name, resolvedName))) continue;
    let policyLine = null;
    try { policyLine = snapshot ? formatPolicyLine(snapshot) : null; } catch { policyLine = null; }
    schools.push({
      name: resolvedName,
      state: row?.state || null,
      baseline: row,
      cds,
      cdsValidated: cds ? isCdsRecordValidated(ragStmts, cds.slug) : false,
      policyLine,
      // The student's own College Fit read (and its web double-check), so
      // the counselor quotes the same label the card shows.
      fitRead,
    });
    if (schools.length >= 4) break;
  }
  const facts = (Array.isArray(evidence) ? evidence : [])
    .filter((f) => String(f?.confidence || "").toLowerCase() === "verified" && (f.source_url || f.source_domain))
    .slice(0, 5);
  return formatVerifiedDataBlock({ schools, facts });
}

// True when the question names a school we hold official data for, so an
// exact-lookup question can be answered from the VERIFIED DATA block.
function hasVerifiedCollegeData(questionText) {
  try {
    for (const name of detectSchoolMentions(questionText, { knownNames: baselineCollegeNames() })) {
      const row = resolveBaselineCollegeRow(db, { schoolName: name });
      if (row && (row.acceptance_rate != null || row.sat_25 != null)) return true;
      if (resolveStoredCdsRecord(ragStmts, { schoolName: row?.name || name })) return true;
      if (readPolicySnapshot(policyScoutStmts, { unitId: row?.unit_id, name: row?.name || name })) return true;
    }
  } catch { /* fall back to the gate */ }
  return false;
}

// Which schools the policy scout watches: every student's current target
// schools, every school with a stored Common Data Set, and every school with
// cached official-page research — i.e. the schools students actually ask
// about. Names are canonicalized against the IPEDS baseline so the scout can
// use the baseline website and unit id.
function collectPolicyScoutTargets() {
  const targets = [];
  const seenStudents = new Set();
  try {
    const rows = db.prepare("SELECT student_id, goals_json FROM profile_snapshots ORDER BY datetime(created_at) DESC, rowid DESC").all();
    for (const row of rows) {
      if (seenStudents.has(row.student_id)) continue;
      seenStudents.add(row.student_id);
      const goals = safeParseJSON(row.goals_json, []);
      const fallbackRows = extractGoalUnitIds(goals)
        .map((u) => db.prepare("SELECT unit_id, name FROM baseline_colleges WHERE unit_id = ?").get(u))
        .filter(Boolean);
      for (const t of extractTargetSchoolNames(goals, fallbackRows)) targets.push({ name: t.schoolName, unitId: t.unitId });
    }
  } catch (err) { console.warn("[policy-scout] student target collection failed:", err.message); }
  try { for (const r of ragStmts.cds.listAll.all()) if (r.school_name) targets.push({ name: r.school_name }); } catch { /* no CDS store */ }
  try {
    for (const r of db.prepare("SELECT DISTINCT display_name FROM college_research_cache").all()) if (r.display_name) targets.push({ name: r.display_name });
  } catch { /* no research cache */ }
  const knownNames = baselineCollegeNames();
  return targets.map((t) => {
    const canonical = detectSchoolMentions(t.name, { knownNames, max: 1 })[0] || t.name;
    const row = resolveBaselineCollegeRow(db, { unitId: t.unitId, schoolName: canonical });
    return { name: row?.name || canonical, unitId: row?.unit_id || t.unitId || null, website: row?.website || null };
  });
}

let policyScoutRunning = null;
async function runScheduledPolicyScout(trigger = "scheduled", { targets = null, maxSchools = null } = {}) {
  if (policyScoutRunning) return { skipped: "already_running" };
  const list = targets || collectPolicyScoutTargets();
  if (!list.length) return { skipped: "no_targets" };
  policyScoutRunning = runPolicyScout(list, {
    stmts: policyScoutStmts,
    factStmts,
    scorecardKey: SCORECARD_API_KEY || null,
    concurrency: Number(process.env.POLICY_SCOUT_CONCURRENCY) > 0 ? Number(process.env.POLICY_SCOUT_CONCURRENCY) : 2,
    maxSchools: maxSchools || (Number(process.env.POLICY_SCOUT_MAX_SCHOOLS) > 0 ? Number(process.env.POLICY_SCOUT_MAX_SCHOOLS) : 60),
    trigger,
  }).finally(() => { policyScoutRunning = null; });
  const summary = await policyScoutRunning;
  console.log(`[policy-scout] ${trigger}: ${summary.checked}/${summary.total} school(s) checked, ${summary.changes} change(s), ${summary.failed} failed`);
  return { changed: summary.changes > 0, ...summary };
}

// Due when the last automatic sweep is a cadence old — or when a newer
// scout version (better discovery/extraction) should re-read every school
// right away rather than serve the older, weaker snapshots.
function policyScoutSchedule(force = null) {
  const last = lastAutomaticRun(policyScoutStmts);
  const staleVersion = last && last.scoutVersion !== SCOUT_VERSION ? "scout_version_changed" : null;
  return scoutRunDue({ lastRun: last, cadenceMs: SCOUT_CADENCE_MS, force: force || staleVersion });
}
async function maybeRunPolicyScout(trigger = "scheduled") {
  if (policyScoutRunning) return { skipped: "already_running" };
  const schedule = policyScoutSchedule();
  if (!schedule.due) return { skipped: schedule.reason, nextRunAt: schedule.nextRunAt };
  return runScheduledPolicyScout(trigger);
}

// Defensive JSON extraction from an LLM text response. Strip JSON/code
// fences, else grab the first object or array block. Returns null on failure
// so callers never crash on malformed model output.
function parseLLMJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/[[{][\s\S]*[}\]]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Map a fixed-OpenRouter adapter error to an informative HTTP response instead
// of an opaque 500. Secret remediation belongs to the local administrator;
// students never manage provider keys or model selection.
function respondLLMError(res, err, label) {
  const up = Number.isInteger(err?.status) ? err.status : null;
  const httpStatus = up === 499 ? 504 : (up && up >= 400 && up < 600 ? up : 502);
  console.error(`[${label}] LLM error${up ? ` (upstream ${up})` : ""}:`, err?.message);
  let friendly;
  if (err?.code === "provider_timeout") friendly = "The AI provider took too long to respond, so the request was stopped. Please try again.";
  else if (up === 429) friendly = "The AI service is rate-limiting requests (HTTP 429). Wait a moment and retry.";
  else if (up === 401 || up === 403) friendly = "The configured OpenRouter credential was rejected. Ask the local administrator to verify it.";
  else if (up === 402) friendly = "The AI service reports insufficient provider credit or quota. Ask the local administrator to review the OpenRouter account.";
  else friendly = "The AI request failed. Please try again; if it persists, ask the local administrator to check OpenRouter.";
  return res.status(httpStatus).json({
    error: friendly,
    detail: err?.message || null,
    code: err?.code || "llm_error",
    provider: err?.provider || null,
    upstreamStatus: up,
  });
}

// Shared narrative-draft generator — single home for the prompt so the
// manual /api/narrative/draft endpoint and the auto-regenerator produce
// identical, SKILL.md-grounded output. Returns the cleaned draft string
// (caller validates/saves). `existing` is the current active narrative (or
// null) so the model can refine rather than discard the student's voice.
async function generateNarrativeDraftText({ profile, existing, callLLM, modelConfig, schoolBlock = "" }) {
  const summary = profileSummaryForPrompt(profile, existing);
  const prompt = `STUDENT PROFILE (their real data — the ONLY basis for the draft):
${summary}
${existing?.narrativeText ? `\nThe student's CURRENT narrative (refine, don't discard their voice):\n"${existing.narrativeText}"` : ""}${schoolBlock}

TASK: Write a DRAFT "narrative" — a ${NARRATIVE_MIN_CHARS}-${NARRATIVE_MAX_CHARS} character first-person self-presentation that captures who this student is academically and what intellectual thread connects their work (a "spike"). This is a starting point the student will edit — NOT an application essay.

RULES:
- First person ("I ..."). ${NARRATIVE_MIN_CHARS}-${NARRATIVE_MAX_CHARS} characters.
- Use ONLY evidence from the profile. Never invent awards, titles, or experiences.
- Name the intended major/field and 1-2 concrete activities or courses that show the thread.
- If the profile shows service, mentorship, inclusivity, or community impact, you may surface it as part of who this student is — but reflect ONLY what the evidence actually supports. Never manufacture empathy, motives, or character qualities the student did not state.
- Plain, authentic, specific — not flowery. One short paragraph.

This is editable scaffolding in the student's OWN voice — a starting point they will rewrite, not a finished essay and not words handed to them. Leave room for the student to add the lived detail and reflection only they can write; do not over-polish it into something that no longer sounds like them.

Return ONLY the draft text, no quotes, no preamble.`;

  const resp = await callLLM({
    model: modelConfig.models?.medium || modelConfig.models?.large,
    max_tokens: 700,
    system: "You draft a short first-person self-presentation grounded ONLY in the student's real profile. Never invent accomplishments. Return only the draft text.",
    messages: [{ role: "user", content: prompt }],
  });
  let draft = (resp?.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  draft = draft.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim();
  if ((draft.startsWith('"') && draft.endsWith('"')) || (draft.startsWith("“") && draft.endsWith("”"))) {
    draft = draft.slice(1, -1).trim();
  }
  if (draft.length > NARRATIVE_MAX_CHARS) draft = draft.slice(0, NARRATIVE_MAX_CHARS);
  return draft;
}

// Auto-update the narrative when ECs/courses/major change. Fire-and-forget
// from the sync route — NEVER throws into the request path. Guarantees:
//   • Only auto-saves over a narrative that is itself source:'auto' (or when
//     none exists). A student-written narrative is NEVER overwritten.
//   • No-ops when the profile fingerprint is unchanged (no redundant LLM).
//   • Skips when OpenRouter is not configured or the student's budget denies
//     the paid call.
const AUTO_NARRATIVE_TRIGGERS = new Set([
  "ec_added", "ec_leadership", "course_added", "course_updated", "major_changed",
]);
async function maybeAutoRegenerateNarrative(studentId, changes) {
  try {
    const relevant = Array.isArray(changes) && changes.some(c => AUTO_NARRATIVE_TRIGGERS.has(c?.type));
    if (!relevant) return { skipped: "no_relevant_change" };

    const profile = assembleProfileForGeneration(studentId);
    if (!profile) return { skipped: "no_profile" };
    const fp = computeProfileFingerprint(profile);
    const existing = getActiveNarrative(ragStmts.narrative, studentId);

    // Protect the student's voice: never overwrite a hand-written narrative.
    if (existing && existing.source === "student") return { skipped: "student_written" };
    // Nothing material changed since the last auto-narrative.
    if (existing && existing.source === "auto" && existing.profileFingerprint === fp) {
      return { skipped: "fingerprint_unchanged" };
    }

    const { modelConfig, callLLM } = buildStudentCallLLM(studentId);
    if (!modelConfig) return { skipped: "openrouter_not_configured" };

    // Tailor the auto-narrative toward the student's saved target schools.
    let schoolBlock = "";
    try {
      const priorities = await getSchoolPriorities(resolveTargetSchools(studentId, null));
      schoolBlock = schoolPrioritiesPromptBlock(priorities);
    } catch { /* non-fatal */ }
    const draft = await generateNarrativeDraftText({ profile, existing, callLLM, modelConfig, schoolBlock });
    try {
      const saved = saveNarrative(ragStmts.narrative, studentId, draft, { source: "auto", profileFingerprint: fp });
      console.log(`[AUTO-NARRATIVE] regenerated for ${String(studentId).slice(0, 8)} (${saved.id.slice(0, 8)})`);
      return { regenerated: true, id: saved.id };
    } catch (e) {
      // Draft failed validation (too short/long) — leave prior narrative intact.
      console.warn("[AUTO-NARRATIVE] draft rejected:", e.message);
      return { skipped: "invalid_draft" };
    }
  } catch (err) {
    if (err?.budget) return { skipped: "budget", code: err.code || "budget_denied" };
    console.warn("[AUTO-NARRATIVE] failed:", err.message);
    return { skipped: "error" };
  }
}

// ───────────────────────────────────────────────────────────
// Target-school tailoring — shared by the EC-idea / narrative /
// course tools so their output is oriented toward the specific
// universities the student wants. Source priority: explicit request
// override → the student's saved goal schools.
// ───────────────────────────────────────────────────────────
function resolveTargetSchools(studentId, requested) {
  if (Array.isArray(requested) && requested.length) {
    return requested
      .map((s) => String(s?.schoolName || s?.name || s || "").trim())
      .filter(Boolean)
      .slice(0, 6);
  }
  try {
    const snap = ragStmts.getLatestSnapshot.get(studentId);
    const goals = safeParseJSON(snap?.goals_json, []);
    const goalUnitIds = extractGoalUnitIds(goals);
    const fallbackRows = goalUnitIds
      .map((u) => db.prepare("SELECT unit_id, name FROM baseline_colleges WHERE unit_id = ?").get(u))
      .filter(Boolean);
    // extractTargetSchoolNames returns {unitId, schoolName} objects; callers
    // (calendar/context, getSchoolPriorities) expect plain strings like the
    // requested-path branch above. Map to the name so this always returns
    // string[] — otherwise s.toLowerCase() downstream throws on the objects.
    return extractTargetSchoolNames(goals, fallbackRows)
      .map((t) => String(t?.schoolName || t?.name || t || "").trim())
      .filter(Boolean)
      .slice(0, 6);
  } catch {
    return [];
  }
}

// For each target school, pull its REAL, citeable priorities from the
// validated Common Data Set (C7 factor weights + admit context). Name-only
// fallback when there's no validated record. Async (dynamic CDS import,
// matching the bundle's pattern).
const C7_PRIORITY_WEIGHTS = Object.freeze({ very_important: 1.0, important: 0.7, considered: 0.35, not_considered: 0.0 });
// An admit rate as a percent with one decimal, from a fraction (0.0923) or
// a percent (9.23); null when there is none.
function admitRatePercentOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct * 10) / 10;
}

async function getSchoolPriorities(schoolNames) {
  if (!Array.isArray(schoolNames) || !schoolNames.length) return [];
  let loadValidatedRecord;
  try { ({ loadValidatedRecord } = await import("./cds-validator.js")); }
  catch { return schoolNames.map((s) => ({ school: s, hasData: false })); }
  const slugify = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const out = [];
  for (const name of schoolNames) {
    let rec = null;
    try { rec = loadValidatedRecord(ragStmts, slugify(name)); } catch { /* ignore */ }
    if (!rec) { out.push({ school: name, hasData: false }); continue; }
    const factors = Object.entries(rec.c7 || {})
      .map(([k, label]) => ({ factor: k, label, weight: C7_PRIORITY_WEIGHTS[label] ?? null }))
      .filter((f) => f.weight != null)
      .sort((a, b) => (b.weight || 0) - (a.weight || 0));
    out.push({
      school: rec.school || name,
      hasData: true,
      // A percent, whatever scale the record used: the validated record
      // holds a fraction (0.0923), and "(admit ~0.0923%)" reached both the
      // course-plan card and the model's target-school block.
      admitRate: admitRatePercentOf(rec.overallAdmitRate),
      topFactors: factors.filter((f) => f.weight >= 0.7).map((f) => f.factor),
      rigorWeight: C7_PRIORITY_WEIGHTS[rec.c7?.rigor] ?? null,
      c7: rec.c7 || null,
      sourceUrl: rec.sourceUrl || null,
    });
  }
  return out;
}

// Promptable block describing what the target schools value. Empty when no
// targets, so callers can append unconditionally.
function schoolPrioritiesPromptBlock(priorities) {
  if (!Array.isArray(priorities) || !priorities.length) return "";
  const lines = priorities.map((p) => {
    if (!p.hasData) return `  • ${p.school} (no Common Data Set on file — use general knowledge cautiously, don't invent)`;
    const fac = (p.topFactors || []).map((f) => String(f).replace(/_/g, " ")).join(", ");
    return `  • ${p.school}${p.admitRate != null ? ` (admit ~${p.admitRate}%)` : ""}${fac ? ` — most-valued factors: ${fac}` : ""}`;
  });
  return `\n\nTARGET SCHOOLS the student is aiming for — tailor toward what THESE schools value (from their Common Data Set where available; do NOT name the schools in the output text, just let their priorities shape emphasis):\n${lines.join("\n")}`;
}

// ───────────────────────────────────────────────────────────
// Admissions calendar awareness — the consultant agent needs to know
// today's date, the current application-cycle phase, typical US deadlines,
// and approximate high-school breaks. Deterministic from the server clock
// (always fresh), so the agent is never date-blind even without web access.
// ───────────────────────────────────────────────────────────
function buildAdmissionsCalendar(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1..12
  // A senior applying in the fall of `cycleStartYear` matriculates the next
  // fall (`cycleEntryYear`). The cycle rolls forward to the NEXT season once
  // RD season is over (February onward): from Feb–Jul the just-finished
  // cycle's EA/ED/RD/deposit dates are all in the past, so the relevant
  // deadlines to outline are the UPCOMING fall's. January is the one month
  // still inside the active RD window, so it stays on that cycle.
  const cycleStartYear = m >= 2 ? y : y - 1;
  const cycleEntryYear = cycleStartYear + 1;
  let phase;
  if (m >= 8 && m <= 10) phase = "early-application season — EA/ED apps due ~Nov 1";
  else if (m === 11) phase = "EA/ED deadlines now; RD apps being finalized";
  else if (m === 12) phase = "early decisions releasing; RD apps due ~Jan 1";
  else if (m === 1) phase = "regular-decision deadlines (~Jan 1-15)";
  else phase = "planning the upcoming cycle — research, essays, and target list for applications this fall";
  return {
    today: now.toISOString().slice(0, 10),
    cycleStartYear,
    cycleEntryYear,
    schoolYear: `${cycleStartYear}–${cycleEntryYear}`,
    applicationCycle: `Class entering Fall ${cycleEntryYear}`,
    phase,
    typicalDeadlines: {
      earlyEaEd: `~Nov 1 ${cycleStartYear} (some Nov 15)`,
      regularDecision: `~Jan 1–15 ${cycleEntryYear}`,
      eaEdDecisionsRelease: `mid–late Dec ${cycleStartYear}`,
      rdDecisionsRelease: `mid-Mar–early-Apr ${cycleEntryYear}`,
      fafsaOpens: `Oct 1 ${cycleStartYear}`,
      cssProfilePriority: `Nov ${cycleStartYear}–Feb ${cycleEntryYear} (varies)`,
      financialAidPriority: `often the ED/EA date, else ~Feb 1 ${cycleEntryYear}`,
      nationalDepositDeadline: `May 1 ${cycleEntryYear}`,
    },
    typicalHsBreaks: {
      summer: `early-June–late-Aug ${cycleStartYear}`,
      thanksgiving: `late Nov ${cycleStartYear}`,
      winter: `~Dec 20 ${cycleStartYear}–early Jan ${cycleEntryYear}`,
      spring: `~Mar–Apr ${cycleEntryYear}`,
    },
    // Concrete ISO fallbacks (parseable) so the UI can always create dated
    // deadline entries even when no per-school web data is available.
    typicalISO: {
      earlyEaEd: `${cycleStartYear}-11-01`,
      regularDecision: `${cycleEntryYear}-01-01`,
      financialAidPriority: `${cycleEntryYear}-02-01`,
      fafsaOpens: `${cycleStartYear}-10-01`,
      nationalDepositDeadline: `${cycleEntryYear}-05-01`,
    },
    note: "Approximate US norms — exact dates vary by school and year; verify on each school's admissions/financial-aid site.",
  };
}

const app = express();
if (WEB_DEPLOYMENT) app.set("trust proxy", 1);

// Assigned when pillar routes mount (see mountPillarRoutes call below). Route
// handlers defined earlier in source order reference it lazily at request time
// — by then it is set. Exposes conveneFromUpload(...) for the EC-upload hook.

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  strictTransportSecurity: NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use(securityResponseMiddleware({ production: NODE_ENV === "production" }));

// Localhost (any port) in development. The Vite dev server and the preview
// tooling bind to varying ports (5173, 5180, 3001, …), so a fixed allowlist
// rejected real browser requests with "CORS: Origin not allowed" → which the
// frontend surfaced as a misleading "Couldn't reach the server" on every POST
// (same-origin GETs send no Origin header, so they slipped through and looked
// fine — masking the bug).
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const allowCors = cors({ origin: true, credentials: true });
app.use((req, res, next) => {
  if (!req.headers.origin) return next();
  if (!isAllowedRequestOrigin(req)) return res.status(403).json({ error: "Origin not allowed." });
  return allowCors(req, res, next);
});

app.use(express.json({ limit: "20mb" }));

app.use((req, _res, next) => {
  req.requestId = crypto.randomUUID();
  next();
});

// A hosted installation cannot accept student data until the counselor has
// supplied every required secret. Static files and the administrator setup
// surface remain reachable during first run.
app.use((req, res, next) => {
  if (!WEB_DEPLOYMENT || WEB_SECRETS_READY || !req.path.startsWith("/api/")) return next();
  if (req.path === "/api/health" || req.path === "/api/methodology" || req.path.startsWith("/api/admin/")) return next();
  return res.status(503).json({
    error: "Counselor setup is required before the student website can be used.",
    code: "installation_setup_required",
  });
});

// ── Rate limiters ──
// RATE_LIMIT_RELAXED=1 multiplies every ceiling so sequential route tests
// sharing one loopback IP don't trip the per-IP limits. Only the test
// harnesses set it — production (web-launcher) and development never do.
const relaxedMax = (max) => process.env.RATE_LIMIT_RELAXED === "1" ? max * 100 : max;
const apiLimiter = rateLimit({ windowMs: 60_000, max: relaxedMax(30), keyGenerator: (req) => hashIP(req.ip), message: { error: "Too many requests." } });
const studentLimiter = rateLimit({ windowMs: 60_000, max: relaxedMax(30), keyGenerator: (req) => hashIP(req.ip) });
const scorecardLimiter = rateLimit({ windowMs: 60_000, max: relaxedMax(40), keyGenerator: (req) => hashIP(req.ip), message: { error: "Too many college search requests." } });
const authLimiter = rateLimit({
  ...AUTH_RATE_LIMIT,
  max: relaxedMax(AUTH_RATE_LIMIT.max),
  keyGenerator: (req) => hashIP(req.ip),
  message: { error: "Too many authentication attempts. Try again later.", code: "auth_rate_limited" },
});
const adminAuthLimiter = rateLimit({
  ...ADMIN_AUTH_RATE_LIMIT,
  max: relaxedMax(ADMIN_AUTH_RATE_LIMIT.max),
  keyGenerator: (req) => hashIP(req.ip),
  message: { error: "Too many administrator authentication attempts. Try again later.", code: "admin_auth_rate_limited" },
});


// ═══════════════════════════════════════════════════════════
// LLM — provider-neutral proxy + provider metadata
// ═══════════════════════════════════════════════════════════

const MAX_TOKENS_LIMIT = 4096;
const LLM_TIMEOUT_MS = 60_000;


// POST /api/llm — provider-neutral chat completion
// Body: {
//   provider?, baseUrl?, apiKey?, model?, tier?,  // BYOK overrides
//   system?, messages, max_tokens?, temperature?,
//   anthropic_beta?  // Anthropic PDF passthrough
// }
// Flow mirrors /api/anthropic but routes through the adapter layer.
app.all(["/api/llm", "/api/llm/providers", "/api/llm/openrouter/models"], apiLimiter, (_req, res) => {
  res.status(410).json({ error: "The generic LLM/BYOK proxy has been removed.", code: "llm_proxy_removed" });
});


// ═══════════════════════════════════════════════════════════
// POST /api/chat — the counseling chat path (fixed administrator OpenRouter)
// ═══════════════════════════════════════════════════════════
// Flow: Input screening → Policy router → Rules engine (T0) →
//       [Model only if needed] → Output screening → 3-lane answer
//
// Paid model calls use the fixed administrator-configured OpenRouter boundary.
// The frontend tier is mapped by server policy to an allowlisted model; caller
// model overrides and tool definitions are not allowed or forwarded.

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

// Replace base64 document/image blocks with their extracted text so a
// text-only provider sees the whole file. Scanned PDFs fall back to bounded
// OCR. Errors become a visible note rather than a silent omission.
// `collector`, when given, receives { index, mime, text } for every block
// whose text was read, so the turn can also file the document as EC
// evidence (see queueChatEvidence) without extracting it twice.
async function attachmentBlockToText(block, collector = null, index = -1) {
  const kind = block.type === "image" ? "image" : "document";
  const mime = String(block.source?.media_type || "").toLowerCase();
  try {
    if (String(block.source?.data || "").length * 0.75 > CHAT_EXTRACT_MAX_BYTES) {
      return `[Attached ${kind} was too large to read (over ${Math.round(CHAT_EXTRACT_MAX_BYTES / 1024)} KB).]`;
    }
    const buf = Buffer.from(block.source.data, "base64");
    let extraction = await extractText(buf, mime);
    if (extraction?.kind === "pdf" && String(extraction.text || "").trim().length < 40) {
      try { extraction = { ...await extractPdfOCR(buf, { maxPages: 6, scale: 1.5, timeoutMs: 20_000 }), kind: "pdf" }; } catch { /* keep the sparse text */ }
    }
    const text = String(extraction?.text || "").trim();
    if (!text) return `[Attached ${kind}: no readable text was found — if it is a scan or photo, a clearer copy may work.]`;
    if (Array.isArray(collector)) collector.push({ index, mime, text });
    const cut = /truncated/.test(String(extraction?.warning || ""));
    return `[Attached ${kind} — full extracted text, ${text.length} characters${cut ? "; the source was longer than the extraction limit, so the end is not included" : ""}]\n${text}\n[End of attached ${kind}]`;
  } catch (err) {
    return `[Attached ${kind} could not be read: ${String(err?.code || err?.message || "extraction failed").slice(0, 80)}]`;
  }
}

async function inlineAttachmentBlocks(messages, collector = null) {
  let inlined = 0;
  const list = Array.isArray(messages) ? messages : [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (!Array.isArray(message?.content)) continue;
    const next = [];
    for (const block of message.content) {
      if ((block?.type === "document" || block?.type === "image") && block.source?.type === "base64" && typeof block.source.data === "string") {
        next.push({ type: "text", text: await attachmentBlockToText(block, collector, index) });
        inlined += 1;
      } else {
        next.push(block);
      }
    }
    message.content = next;
  }
  return inlined;
}

// A file attached in chat is EC evidence too. Read the files of one turn
// into the activity each concerns (a deterministic name match; a file that
// names no activity stays unlinked) and, when anything was linked, refresh
// the strength vectors so the evidence shows at once. Fire-and-forget: a
// chat turn never waits for it, and a failure is logged, not surfaced.
function queueChatEvidence(studentId, files, messageText, { threadId = null, messageId = null, source = "chat" } = {}) {
  if (!studentId || !Array.isArray(files) || files.length === 0) return;
  setImmediate(async () => {
    try {
      const profile = assembleProfileForGeneration(studentId);
      const result = harvestEvidence(ragStmts.strength, studentId, files, {
        activities: profile?.activities || [],
        messageText,
        seal: chatHistory.sealText,
        threadId,
        messageId,
      });
      if (result.linked.length) {
        console.log(`[EC evidence] ${source}: linked ${result.linked.map((l) => `${l.name} → ${l.ecName}`).join(", ")}`);
        await recomputeStrengthForStudent(studentId);
      }
    } catch (err) {
      console.warn("[EC evidence] chat harvest failed:", err?.message);
    }
  });
}

// One strength recompute for a student from the stored snapshot, narrative
// and attachments — what the sync does, callable after evidence lands.
async function recomputeStrengthForStudent(studentId) {
  const snap = ragStmts.getLatestSnapshot.get(studentId);
  if (!snap) return null;
  const active = getActiveNarrative(ragStmts.narrative, studentId);
  return recomputeStudentECStrengthVectors(ragStmts.strength, studentId, {
    activities: safeParseJSON(snap.activities_json, []),
    narrative: active?.narrativeText || null,
    narrativeThemes: active?.themes || [],
    narrativeHash: active?.hash || null,
    narrativeId: active?.id || null,
    majorInterest: snap.major_interest || null,
    llmClient: buildDefaultLLMClient(ragStmts.narrativeFitCache),
    prestigeAdapter: resolvePrestigeAdapter(studentId),
    ragStmts,
  });
}

function llmResponseText(response) {
  return Array.isArray(response?.content)
    ? response.content.filter((block) => block?.type === "text").map((block) => block.text || "").join("\n").trim()
    : String(response?.text || "").trim();
}

function regulatedResultForChat(classification, payload) {
  const subIntent = String(classification?.subIntent || "").toLowerCase();
  if (subIntent.includes("fafsa") || subIntent.includes("eligibility")) {
    return runFAFSAEligibilityCheck(payload.fafsa_profile || payload.student_data || {});
  }
  if (subIntent.includes("deadline")) {
    return calculateDeadlineStatus(
      payload.deadline || payload.deadline_date || null,
      payload.application_type || "regular_decision",
    );
  }
  return {
    message: "No deterministic rule is available for this regulated question.",
    advisory: "Use the official source or a qualified school counselor before acting on this information.",
  };
}

// Answer a chat deadline question from the official-source research cache
// when the query names schools whose admissions pages have been researched
// (see college-research.js). Returns null when nothing cached matches.
// `current: true` ignores a snapshot read by an older scout version, so the
// caller reads the school's pages again before answering from it.
function deadlinesFromResearchCache(userText, { current = false } = {}) {
  let names = [];
  // Schools named in the question (aliases + baseline names). This used to
  // pass the question STRING to extractTargetSchoolNames, which iterates a
  // goals array — so it "found" single characters and never matched a school.
  try { names = detectSchoolMentions(userText, { knownNames: baselineCollegeNames() }); } catch { return null; }
  const found = [];
  for (const name of names.slice(0, 3)) {
    let record = readCachedDeadlines(collegeResearchStmts, name);
    if (!record) {
      // The daily policy scout reads the same official pages; its snapshot
      // stands in when no model-researched record is cached.
      try {
        const snapshot = readPolicySnapshot(policyScoutStmts, { name });
        record = snapshot && (!current || snapshotIsCurrent(snapshot)) ? snapshotAsDeadlineRecord(snapshot) : null;
      } catch { record = null; }
    }
    if (record) found.push(record);
  }
  if (!found.length) return null;
  const labels = {
    ea: "Early Action", ed: "Early Decision", edII: "Early Decision II", rd: "Regular Decision",
    financialAid: "Financial aid priority", commitBy: "Commit by", decisionRelease: "RD decisions",
  };
  const lines = found.map((record) => {
    const parts = Object.entries(labels)
      .map(([key, label]) => record.deadlines?.[key] ? `${record.labels?.[key] || label}: ${record.deadlines[key]}` : null)
      .filter(Boolean).join(" · ");
    return `${record.displayName} (${record.cycle} cycle): ${parts}`;
  });
  const first = found[0];
  // The student may ask for one plan the pages do not state (NJIT's site
  // gives an Early Action date and admits on a rolling basis after it). Say
  // so instead of answering a different question with the dates on file.
  const asked = /\bregular\s+(?:decision|action)\b|\bRD\b/i.test(userText) ? "rd"
    : /\bearly\s+decision\s+(?:ii|2)\b|\bED\s?(?:II|2)\b/i.test(userText) ? "edII"
      : /\bearly\s+decision\b|\bED\b/i.test(userText) ? "ed"
        : /\b(?:restrictive\s+)?early\s+action\b|\bR?EA\b/i.test(userText) ? "ea" : null;
  const missingPlan = asked && !first.deadlines?.[asked] ? asked : null;
  const note = missingPlan
    ? ` The pages read do not state a ${labels[missingPlan]} deadline for ${first.displayName}${missingPlan === "rd" ? " (some schools admit on a rolling basis after Early Action)" : ""} — check the linked admissions page.`
    : "";
  return {
    message: lines.join("\n") + note,
    source_url: first.sourceUrl,
    source_title: `${first.displayName} official admissions pages`,
    confidence: "verified",
    trust_level: "official",
    advisory: `Dates were read from the school's own admissions pages on ${String(first.extractedAt || "").slice(0, 10)}. Confirm on the linked page before relying on them.`,
  };
}


// ═══════════════════════════════════════════════════════════
// REMOVED PUBLIC COMPATIBILITY SURFACES
// ═══════════════════════════════════════════════════════════

app.all([
  "/api/audit",
  "/api/audit/dashboard",
  "/api/audit/export",
  "/api/notify-parent",
  "/api/credible-sources",
  "/api/beta-signup",
  "/api/beta-impact",
  "/dashboard",
], (_req, res) => res.status(410).json({ error: "This public endpoint has been removed." }));


// ─── Counselor-auth admin endpoints ──────────────────────────────────
// Manual trigger for seasonal credible-source research. Body:
//   { colleges?: string[], topN?: number, subjects?: [{subject_id,name}], skipAP?: bool }
// Runs synchronously (keep the set small — default topN 5 — to stay within the
// request timeout; full sweeps belong on the scheduled job). Needs an
// OpenRouter operator key.
function adminSessionResponse(req, res, result, status = 200) {
  setAdminCookie(req, res, result.token);
  return res.status(status).json({
    authenticated: true,
    csrfToken: result.csrfToken,
    ...(result.recoveryCode ? { recoveryCode: result.recoveryCode } : {}),
  });
}


async function validateAdminSecret(kind, value) {
  const secret = String(value || "").trim();
  if (kind === "encryption") return { valid: /^[0-9a-f]{64}$/i.test(secret), kind };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    if (kind === "openrouter") {
      if (!/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(secret)) return { valid: false, kind };
      const response = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${secret}` }, signal: controller.signal,
      });
      return { valid: response.ok, kind };
    }
    if (kind === "scorecard") {
      if (secret !== "DEMO_KEY" && !/^[A-Za-z0-9]{20,64}$/.test(secret)) return { valid: false, kind };
      const url = new URL("https://api.data.gov/ed/collegescorecard/v1/schools.json");
      url.searchParams.set("api_key", secret);
      url.searchParams.set("_fields", "id");
      url.searchParams.set("_per_page", "1");
      const response = await fetch(url, { signal: controller.signal });
      return { valid: response.ok, kind };
    }
    return { valid: false, kind: "unknown" };
  } catch {
    return { valid: false, kind, unavailable: true };
  } finally {
    clearTimeout(timeout);
  }
}


function requireWebConfiguration(req, res, next) {
  if (!WEB_DEPLOYMENT) {
    return res.status(405).json({ error: "Secret changes require the website launcher.", code: "web_launcher_required" });
  }
  if (WEB_CONFIG_KEY.length < 32) {
    return res.status(503).json({ error: "Encrypted website configuration is unavailable.", code: "web_config_unavailable" });
  }
  next();
}

function scheduleWebConfigurationRestart() {
  setTimeout(() => {
    if (typeof process.send === "function") process.send({ type: "web-config-updated" });
  }, 200).unref();
}


// The counselor's model page: packaged options, the models the catalog
// scout found (per price band, newest first), every candidate for review,
// and the scout's schedule.
function adminModelsPayload() {
  const packaged = OPENROUTER_MODEL_OPTIONS.map((option) => {
    const live = OPENROUTER_CATALOG.byId.get(option.id);
    return {
      ...option,
      available: live ? true : (OPENROUTER_CATALOG.reachable === true ? false : null),
      contextLength: live?.contextLength || null,
      pricing: live?.pricing || null,
    };
  });
  const discovered = listDynamicModelOptions(modelCatalogStmts, { catalog: OPENROUTER_CATALOG });
  const schedule = modelCatalogScoutSchedule();
  return {
    models: { ...OPENROUTER_TARGETS },
    options: [...packaged, ...discovered],
    candidates: listDynamicModelOptions(modelCatalogStmts, { catalog: OPENROUTER_CATALOG, includeDismissed: true }),
    catalogScout: {
      enabled: MODEL_SCOUT_ENABLED,
      cadenceDays: SCOUT_CADENCE_DAYS,
      lastRun: lastModelCatalogRun(modelCatalogStmts),
      nextRunAt: schedule.nextRunAt,
      due: schedule.due,
    },
    catalogCheckedAt: OPENROUTER_CATALOG.lastFetched,
  };
}


app.all([
  "/api/admin/seasonal-research/run",
  "/api/admin/admissions-intel/summary",
  "/api/admin/admissions-intel/ipeds-growth",
  "/api/admin/admissions-intel/ipeds-growth/load-file",
  "/api/admin/admissions-intel/major-policy",
  "/api/admin/admissions-intel/strategic-focus",
  "/api/cds/ingest",
  "/api/cds/revalidate",
  "/api/cds/canonical/:slug.xlsx",
  "/api/cds/canonical/export-all",
  "/api/review/stats",
  "/api/ec/competitions/search",
  "/api/ec/cache-memory",
  "/api/ec/prestige/:activityName",
  "/api/ec/prestige/recompute",
  "/api/ec/component-cache",
], (_req, res) => {
  res.status(410).json({ error: "The administrator account is limited to secret configuration." });
});

app.all(["/api/setup/status", "/api/setup/initialize", "/api/students/apikey"], (_req, res) => {
  res.status(410).json({ error: "Legacy setup-token and student BYOK APIs have been removed.", code: "surface_removed" });
});


function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function tablesContainingColumn(database, columnName) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map((row) => row.name)
    .filter((table) => database.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table)})`).all().some((column) => column.name === columnName));
}

function collectStudentRows(database, studentId, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const out = {};
  for (const table of tablesContainingColumn(database, "student_id")) {
    if (excluded.has(table)) continue;
    out[table] = database.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)} WHERE student_id = ?`).all(studentId);
  }
  return out;
}

function deleteStudentRows(database, studentId) {
  const tables = tablesContainingColumn(database, "student_id");
  const tx = database.transaction(() => {
    const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (names.has("chat_messages") && names.has("chat_threads")) {
      database.prepare("DELETE FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE student_id = ?)").run(studentId);
    }
    if (names.has("evidence_items")) {
      database.prepare("DELETE FROM evidence_items WHERE entity_type = 'student' AND entity_id = ?").run(studentId);
    }
    if (names.has("canonical_facts")) {
      database.prepare("DELETE FROM canonical_facts WHERE entity_type = 'student' AND entity_id = ?").run(studentId);
    }
    if (names.has("college_values")) {
      const cols = database.prepare("PRAGMA table_info(college_values)").all();
      if (cols.some((column) => column.name === "extracted_by_student_id")) {
        database.prepare("DELETE FROM college_values WHERE extracted_by_student_id = ?").run(studentId);
      }
    }
    for (const table of tables) {
      database.prepare(`DELETE FROM ${quoteSqlIdentifier(table)} WHERE student_id = ?`).run(studentId);
    }
  });
  tx();
}

async function removeStudentFiles(studentId) {
  await removeStudentStorage(studentId, DATA_DIR);
  const root = path.resolve(EC_ATTACHMENTS_DIR);
  const target = path.resolve(root, String(studentId));
  if (target !== root && target.startsWith(root + path.sep)) {
    await fs.promises.rm(target, { recursive: true, force: true });
  }
}


// Opportunistic live CDS search: when a searched school is not already in the
// validated store, fetch + parse + persist its Common Data Set via the live
// repository pipeline so College Fit can ground in real numbers next time.
// Best-effort and time-boxed; a per-slug cooldown prevents re-fetching schools
// that aren't in the repository (or whose PDFs won't parse) on every request.
const cdsLiveAttemptAt = new Map(); // slug -> epoch ms of last attempt
const CDS_LIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

async function searchAndPersistCdsRecord(schoolName) {
  if (!schoolName) return null;
  const slug = slugifySchoolName(schoolName);
  if (!slug) return null;
  const last = cdsLiveAttemptAt.get(slug) || 0;
  if (Date.now() - last < CDS_LIVE_COOLDOWN_MS) return null; // recently tried; don't hammer
  cdsLiveAttemptAt.set(slug, Date.now());
  try {
    const { ingestOne } = await import("./cds-ingest-pipeline.js");
    const r = await ingestOne(ragStmts, schoolName);
    const persisted = r && ["ok", "discrepancies", "scope_mismatch", "no_truth"].includes(r.status);
    if (persisted) {
      // Guard against the repository's fuzzy index binding the wrong school
      // (e.g. "Boston University" → "Boston College"). If the matched name is
      // not the same institution, discard and fall back to IPEDS baseline.
      if (!schoolNamesCompatible(schoolName, r.school)) {
        console.warn(`[cds/live-search] repository returned "${r.school}" for "${schoolName}" — rejecting mismatch`);
        return null;
      }
      console.log(`[cds/live-search] ingested ${schoolName} → ${r.slug} (${r.status})`);
      return resolveStoredCdsRecord(ragStmts, { schoolName, slug: r.slug });
    }
    console.log(`[cds/live-search] no CDS for ${schoolName} (${r?.status || "unknown"})`);
  } catch (e) {
    console.warn(`[cds/live-search] failed for ${schoolName}:`, String(e.message).slice(0, 160));
  }
  return null;
}

// A cheap fingerprint of the CDS store (row count + latest update). Folded into
// the positioning/CDS cache keys so a CDS refresh invalidates stale fit results.
function currentCdsVersion() {
  try {
    const r = db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM cds_records").get();
    return `${r?.n || 0}:${r?.m || "0"}`;
  } catch {
    return "0";
  }
}

// The College Fit computation, shared by the targets route and the
// double-check. Returns the response payload plus, unless served from the
// positioning cache, the per-target inputs the scores were computed from.
async function runPositioning({ studentId, body = {}, bypassCache = false } = {}) {
    const snap = ragStmts.getLatestSnapshot.get(studentId);
    if (!snap) throw httpError(404, "No profile data");

    const goals = safeParseJSON(snap.goals_json, []);
    const goalUnitIds = extractGoalUnitIds(goals);
    const fallbackRows = goalUnitIds
      .map((unitId) => db.prepare("SELECT unit_id, name, state, sat_25, sat_75, act_25, act_75, acceptance_rate, avg_gpa_admitted, top_majors_json, source FROM baseline_colleges WHERE unit_id = ?").get(unitId))
      .filter(Boolean);

    const requestedTargets = Array.isArray(body?.targets) ? body.targets : null;
    const rawTargets = requestedTargets || extractTargetSchoolNames(goals, fallbackRows);
    if (!rawTargets.length) throw httpError(400, "No target universities found");

    const requestedMajor = body?.major || snap.major_interest || null;
    const refreshCds = Boolean(body?.refreshCds);
    const cacheKey = computeCdsQueryCacheKey(rawTargets);
    // Fold a CDS data version into every cache key so a CDS refresh (which
    // bumps cds_records.updated_at) invalidates stale cached fit results — the
    // reason a freshly-scraped CDS wasn't reaching the College Fit tab.
    const cdsVersion = currentCdsVersion();
    let cdsResults = null;
    if (!refreshCds) {
      const cachedCds = getScorecardQueryCache("cds_targets", { cacheKey, cdsVersion, targets: rawTargets });
      cdsResults = cachedCds?.data?.results || null;
      // The read is this student's: keyed by student and by the snapshot
      // it was computed from, so one student's fit (which now carries their
      // own scores, rank and GPA against the school) is never served to
      // another with the same targets, and a profile edit recomputes it.
      const cachedPositioning = bypassCache ? null : getScorecardQueryCache("positioning_targets", { cacheKey, cdsVersion, targets: rawTargets, major: requestedMajor, studentId, snapshot: snap.id });
      if (cachedPositioning?.data) {
        return { payload: cachedPositioning.data, cached: true, internals: null };
      }
    }

    if (!cdsResults) {
      cdsResults = (await resolveAndParseCdsTargets(rawTargets));
      putScorecardQueryCache("cds_targets", { cacheKey, cdsVersion, targets: rawTargets }, {
        targets: rawTargets,
        results: cdsResults,
        source: "College Transitions CDS repository",
      });
    }

    const strengthRows = ragStmts.strength.getByStudent.all(studentId);
    const narrative = getActiveNarrative(ragStmts.narrative, studentId);
    const studentModel = buildStudentModel({
      gpa_unweighted: snap.gpa_unweighted,
      gpa_weighted: snap.gpa_weighted,
      courses_json: snap.courses_json,
      test_scores_json: snap.test_scores_json,
      ap_scores_json: snap.ap_scores_json,
      class_rank_json: snap.class_rank_json,
      activities_json: snap.activities_json,
      major_interest: requestedMajor,
    }, strengthRows, narrative);

    const majorPolicies = body?.majorPolicies || {};
    const ipedsGrowthByBucket = body?.ipedsGrowthByBucket || {};
    // Live CDS search: when a searched school isn't already in the store,
    // fetch + parse + persist its CDS (Drive-hosted PDFs are supported; the
    // ~10% Google-Sheets/Docs sources are skipped and fall back to IPEDS
    // baseline). On by default; live-parsed records are tagged unvalidated
    // (lower confidence) so a mis-parse can't masquerade as ground truth.
    const searchCds = body?.searchCds !== false;

    // Web fallback: when neither the store nor the live PDF pipeline yields a
    // CDS, use the student's highest web-capable model to search + read the
    // school's CDS. On by default; budget-gated, BYOK-required, capped per
    // request, and cooldown-deduped so it can't run away on cost. Results are
    // tagged unvalidated (web-read) with lower confidence.
    const internals = [];
    const scoredTargets = await Promise.all(cdsResults.map(async (cdsResult) => {
      const requested = rawTargets.find((target) =>
        (cdsResult.unitId && normalizeUnitId(target.unitId) === normalizeUnitId(cdsResult.unitId)) ||
        String(target.schoolName || "").toLowerCase() === String(cdsResult.schoolName || "").toLowerCase()
      ) || null;

      const resolvedUnitId = normalizeUnitId(cdsResult.unitId || requested?.unitId);
      const collegeRow = resolveBaselineCollegeRow(db, {
        unitId: resolvedUnitId,
        schoolName: cdsResult.schoolName || requested?.schoolName,
      });

      // ── Prefer the on-disk validated CDS record over the live fetch ──
      // The stored record carries real C7 weights, a validated admit rate,
      // and enrolled test-score ranges, so the calculation grounds in real
      // data (and evidence confidence stops reading "Very Low") whenever we
      // have a CDS record for this school.
      const lookupName = cdsResult.schoolName || requested?.schoolName || collegeRow?.name;
      let storedCds = resolveStoredCdsRecord(ragStmts, { schoolName: lookupName });
      // Not in the store yet? Search this university's CDS live, parse, and
      // persist it — so searching a school in College Fit also pulls its CDS.
      if (!storedCds && searchCds) {
        storedCds = await searchAndPersistCdsRecord(lookupName);
      }
      const cdsValidated = storedCds ? isCdsRecordValidated(ragStmts, storedCds.slug) : false;
      const cdsVerified = storedCds ? cdsVerification(ragStmts, storedCds.slug) : "unverified";
      const effectiveCds = storedCds
        ? cdsRecordToPositioningResult(storedCds, { liveFallback: cdsResult, unitId: resolvedUnitId, validated: cdsVerified === "validated", verification: cdsVerified })
        : cdsResult;

      // Validated CDS admit rate takes precedence over the IPEDS baseline.
      const cdsAdmitPercent = storedCds?.overallAdmitRate != null
        ? Math.round(storedCds.overallAdmitRate * 1000) / 10
        : null;
      const baselineAdmitPercent = collegeRow?.acceptance_rate != null
        ? Math.round(Number(collegeRow.acceptance_rate) * 1000) / 10
        : null;

      // When we have a VALIDATED CDS record, its enrolled ranges are the
      // freshest ground truth — prefer them over the static IPEDS baseline so
      // the academic-readiness scoring reflects the newest CDS (the baseline
      // row, used first before, made fit ignore a just-scraped CDS). Fall back
      // to baseline only for fields the CDS lacks.
      const cdsFirst = storedCds && cdsValidated;
      const pick = (cdsVal, baseVal) => (cdsFirst ? (cdsVal ?? baseVal) : (baseVal ?? cdsVal));
      const collegeContext = {
        unitId: collegeRow?.unit_id || resolvedUnitId || null,
        name: collegeRow?.name || storedCds?.school || cdsResult.schoolName,
        state: collegeRow?.state || null,
        sat25: pick(storedCds?.enrolledSAT?.p25, collegeRow?.sat_25) ?? null,
        sat75: pick(storedCds?.enrolledSAT?.p75, collegeRow?.sat_75) ?? null,
        act25: pick(storedCds?.enrolledACT?.p25, collegeRow?.act_25) ?? null,
        act75: pick(storedCds?.enrolledACT?.p75, collegeRow?.act_75) ?? null,
        acceptanceRate: cdsAdmitPercent ?? baselineAdmitPercent ?? effectiveCds?.parsed?.admitRatePercent ?? null,
        avgGpaAdmitted: pick(storedCds?.enrolledGPA?.avg, collegeRow?.avg_gpa_admitted) ?? effectiveCds?.parsed?.gpaAverage ?? null,
        topMajors: safeParseJSON(collegeRow?.top_majors_json, []),
        source: cdsFirst ? "cds_store" : (collegeRow?.source || (storedCds ? "cds_store" : "baseline_colleges")),
      };

      // ── College Scorecard fallback ──────────────────────────────────
      // The CDS store covers a few dozen schools and, on a fresh deployment,
      // baseline_colleges holds only the manually curated set — so most
      // searched schools reached this point with NO stats at all and the fit
      // calibration had nothing to work with. The live Scorecard API (the
      // Dept. of Education's IPEDS data) fills admit rate and test ranges for
      // any US school, connecting the CDS pipeline to Scorecard data.
      if (SCORECARD_API_KEY &&
          collegeContext.sat25 == null && collegeContext.act25 == null && collegeContext.acceptanceRate == null) {
        try {
          const scorecardName = expandCollegeAlias(collegeContext.name);
          const scorecardHit = collegeContext.unitId
            ? await getCollegeById(SCORECARD_API_KEY, collegeContext.unitId)
            : pickScorecardHit(
              (await searchScorecard(SCORECARD_API_KEY, { name: scorecardName, limit: 20 }))?.results,
              scorecardName,
            );
          if (scorecardHit) {
            collegeContext.unitId = collegeContext.unitId || scorecardHit.unitId || null;
            collegeContext.name = collegeContext.name || scorecardHit.name;
            collegeContext.state = collegeContext.state || scorecardHit.state || null;
            collegeContext.sat25 = scorecardHit.sat25 ?? null;
            collegeContext.sat75 = scorecardHit.sat75 ?? null;
            collegeContext.act25 = scorecardHit.act25 ?? null;
            collegeContext.act75 = scorecardHit.act75 ?? null;
            collegeContext.acceptanceRate = scorecardHit.acceptanceRate ?? null;
            collegeContext.source = "college_scorecard";
          }
        } catch (err) {
          console.warn("[POSITIONING] Scorecard fallback failed:", err?.message);
        }
      }

      const majorPolicy =
        resolveMajorPolicyForSchool(admissionsIntelStmts, {
          unitId: collegeContext.unitId,
          schoolName: collegeContext.name,
          major: requestedMajor,
        }) ||
        majorPolicies?.[collegeContext.unitId] ||
        majorPolicies?.[collegeContext.name] ||
        null;
      const ipedsGrowthSignal = resolveIpedsGrowthForMajor(admissionsIntelStmts, {
        unitId: collegeContext.unitId,
        major: requestedMajor,
      });
      const strategicSignals = resolveStrategicFocusForSchool(admissionsIntelStmts, {
        unitId: collegeContext.unitId,
        major: requestedMajor,
        limit: 5,
      });
      const positioningOptions = {
        major: requestedMajor,
        majorPolicy,
        ipedsGrowthByBucket: {
          ...(ipedsGrowthByBucket || {}),
          [studentModel.majorBucket]: ipedsGrowthSignal?.growthRate ?? ipedsGrowthByBucket?.[studentModel.majorBucket] ?? null,
        },
        strategicSignals,
      };
      const positioning = buildPositioningForTarget(studentModel, collegeContext, effectiveCds, positioningOptions);
      internals.push({
        schoolName: positioning.schoolName,
        collegeContext: { ...collegeContext },
        effectiveCds,
        options: positioningOptions,
        website: collegeRow?.website || null,
        cdsYear: storedCds?.year ?? null,
        cdsValidated,
      });
      // Surface where the numbers came from so the card can link to the CDS
      // source and show the reporting year.
      positioning.dataProvenance = effectiveCds?.provenance || {
        kind: storedCds
          ? "cds_store"
          : (cdsResult?.fetchStatus === "ok"
            ? "cds_live"
            : (collegeContext.source === "college_scorecard" ? "college_scorecard" : "baseline_only")),
        validated: Boolean(storedCds),
        sourceUrl: effectiveCds?.sourceUrl
          || (collegeContext.source === "college_scorecard" ? "https://collegescorecard.ed.gov/" : null),
      };
      return positioning;
    }));

    const payload = {
      major: requestedMajor,
      modelVersion: "positioning_mvp_v1",
      separation: {
        admissibility: "academic preparation for the target school-major pair",
        competitiveness: "crowding and selectivity pressure in the target applicant pool",
        fit: "alignment with institutional and departmental priorities",
        confidence: "strength and directness of the supporting evidence",
      },
      source: "College Transitions CDS repository + NCES/IPEDS baseline + unified EC strength",
      targets: scoredTargets,
    };

    putScorecardQueryCache("positioning_targets", { cacheKey, cdsVersion, targets: rawTargets, major: requestedMajor, studentId, snapshot: snap.id }, payload);
    for (const target of scoredTargets) rememberFitRead(studentId, target);
    return { payload, cached: false, internals };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}


// Tiny local helper for server-side JSON parsing
function safeParseJSON(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch { return fallback; }
}


// ═══════════════════════════════════════════════════════════
// EC STRENGTH (4-factor) + NARRATIVE + FILE UPLOAD ENDPOINTS
// ═══════════════════════════════════════════════════════════
// Parallel surface for the 4-factor strength vectorizer (dedication,
// achievement, leadership, narrative_fit) plus its supporting narrative
// store and attachment uploads. The 5-factor endpoints above stay
// unchanged — these are additive.

const EC_ATTACHMENTS_DIR = path.join(DATA_DIR, "ec-attachments");
fs.mkdirSync(EC_ATTACHMENTS_DIR, { recursive: true });

// Multer disk storage — pinning to disk (not memory) avoids holding a
// second 10 MB buffer in RAM while OCR runs.
const ecUploadStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const studentDir = path.join(EC_ATTACHMENTS_DIR, String(req.studentId || "anon"));
    fs.mkdirSync(studentDir, { recursive: true });
    cb(null, studentDir);
  },
  filename: (_req, file, cb) => {
    // Intermediate name; we rename to `{contentHash}.{ext}` after extraction
    const ext = (file.originalname.match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}.tmp`);
  },
});

const ecUpload = multer({
  storage: ecUploadStorage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (isSupportedMime(file.mimetype)) return cb(null, true);
    const err = new Error(`Unsupported MIME type: ${file.mimetype}`);
    err.code = "UNSUPPORTED_MIME";
    cb(err, false);
  },
});

// POST /api/ec/upload — upload a single supporting file (PDF/DOCX/text/image)
// tied to an EC. Runs text extraction synchronously so the client sees a
// preview on return. If extraction fails we still persist the row with
// status="failed" so retries are possible without re-uploading.
// ═══════════════════════════════════════════════════════════
// CHAT FILE TEXT EXTRACTION
// ═══════════════════════════════════════════════════════════
// Used by the chat-attachment flow when the student uploads a
// Word document (.docx / .doc) or another non-plain-text format
// the browser can't read as UTF-8. Frontend sends base64; we run
// it through file-extractors.js (mammoth for docx, pdf-parse for
// pdf, plain reader for text) and return the extracted text so
// the frontend can paste it into the next prompt.
//
// Auth-gated + rate-limited via studentLimiter. Body size capped
// at MAX_SCHOOL_FILE_SIZE_BYTES (4 MB) on the frontend; this
// endpoint adds a second cap server-side as defense-in-depth.
const CHAT_EXTRACT_MAX_BYTES = 6 * 1024 * 1024; 


// LLM semantic ranker for candidate EC ideas. It judges genuine fit to the
// student's narrative/profile/target schools using only supplied context.
// External prestige is never invented because general web tools are disabled.
// The caller merges its output over the deterministic baseline and falls back
// cleanly on any model failure.
const RANK_TIERS = ["tier_1_distinctive", "tier_2_strong", "tier_3_developing", "tier_4_foundational"];
async function llmRankCandidates({ callLLM, modelConfig, studentId, active, candidates, targetSchools }) {
  const profile = assembleProfileForGeneration(studentId) || {};
  const summary = profileSummaryForPrompt(profile, active);
  const priorities = await getSchoolPriorities(targetSchools || []);
  const schoolBlock = schoolPrioritiesPromptBlock(priorities);
  const themes = (active?.themes || []).map((th) => (typeof th === "string" ? th : th?.theme)).filter(Boolean).slice(0, 12).join(", ");
  const list = candidates.slice(0, 25)
    .map((c, i) => `${i + 1}. ${String(c?.name || "").trim()}${c?.description ? ` — ${String(c.description).trim()}` : ""}`)
    .join("\n");
  const prompt = `You are ranking candidate extracurricular IDEAS a student is weighing, by how much each would strengthen THIS student's application.

STUDENT NARRATIVE (the story everything should reinforce):
"${active?.narrativeText || ""}"
Narrative themes: ${themes || "(none yet)"}

STUDENT PROFILE:
${summary}${schoolBlock}

CANDIDATE IDEAS:
${list}

Judge each idea SEMANTICALLY — do NOT rely on literal keyword overlap. Weigh how strongly it reinforces the student's narrative and intended major and how well it fits the target schools' supplied priorities. No browsing is available: never claim external selectivity, prestige, or feasibility unless the supplied context supports it. Never invent facts about the student.

Return ONLY a JSON array, exactly one object per candidate, no prose, no markdown:
[
  {
    "name": "<exact candidate name from the list>",
    "fit": <number 0..1 — how much it strengthens THIS application>,
    "tier": "tier_1_distinctive|tier_2_strong|tier_3_developing|tier_4_foundational",
    "rationale": "<1-2 sentences, specific to this student and their story>",
    "prestigeNote": "<optional one line on real selectivity/prestige if researched>",
    "sources": ["<url you used>", "..."]
  }
]`;
  const resp = await callLLM({
    // Semantic ranking uses the packaged LARGE/reasoning tier. Reasoning
    // models burn output budget on internal thinking before the visible JSON,
    // so allow a generous max_tokens floor.
    model: modelConfig.models?.large || modelConfig.models?.medium,
    max_tokens: 8192,
    system: "You are a precise, honest college admissions analyst. Rank candidate ECs by genuine fit to the student, grounded in real evidence. Output ONLY the requested JSON array.",
    messages: [{ role: "user", content: prompt }],
  });
  const text = (resp?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const parsed = parseLLMJson(text);
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.candidates) ? parsed.candidates : []);
  return arr
    .map((it) => ({
      name: String(it?.name || "").trim(),
      fit: Math.max(0, Math.min(1, Number(it?.fit))),
      tier: RANK_TIERS.includes(it?.tier) ? it.tier : null,
      rationale: String(it?.rationale || "").slice(0, 400),
      prestigeNote: it?.prestigeNote ? String(it.prestigeNote).slice(0, 300) : null,
      sources: Array.isArray(it?.sources) ? it.sources.slice(0, 5).map((u) => String(u).slice(0, 400)) : [],
    }))
    .filter((x) => x.name && Number.isFinite(x.fit));
}

// LLM re-rank for the Spike Finder: decide which existing activities should
// lead the application using the narrative, target-school priorities, and
// supplied factor evidence—not unsupported outside prestige claims.
async function llmRankSpike({ callLLM, modelConfig, studentId, active, vectors, targetSchools }) {
  const profile = assembleProfileForGeneration(studentId) || {};
  const summary = profileSummaryForPrompt(profile, active);
  const priorities = await getSchoolPriorities(targetSchools || []);
  const schoolBlock = schoolPrioritiesPromptBlock(priorities);
  const list = vectors.slice(0, 25).map((v, i) => {
    const f = v.factors || {};
    return `${i + 1}. ${v.ecName} [tier=${v.tierLabel || "?"}; major_spike=${(f.major_spike ?? 0).toFixed?.(2) ?? f.major_spike}; narrative_fit=${(f.narrative_fit ?? 0).toFixed?.(2) ?? f.narrative_fit}; prestige=${(f.prestige ?? 0).toFixed?.(2) ?? f.prestige}]`;
  }).join("\n");
  const prompt = `Decide which of this student's EXISTING activities should LEAD their application (the 2-3 that define their "spike"), and which are supporting.

STUDENT NARRATIVE:
"${active?.narrativeText || "(none yet)"}"

STUDENT PROFILE:
${summary}${schoolBlock}

ACTIVITIES (with current factor scores):
${list}

Judge holistically: which activities most define a coherent, distinctive story aligned to the intended major and the target schools' supplied priorities. No browsing is available: rely only on the supplied factor evidence and never invent external prestige or achievements.

Return ONLY a JSON array, one object per activity, no prose:
[
  { "name": "<exact activity name>", "lead": <true|false>, "leadScore": <0..1>, "rationale": "<1 sentence why it leads or supports>", "sources": ["<url>"] }
]`;
  const resp = await callLLM({
    // Packaged LARGE/reasoning tier for semantic spike selection. Generous
    // max_tokens for the thinking phase.
    model: modelConfig.models?.large || modelConfig.models?.medium,
    max_tokens: 8192,
    system: "You are a precise college admissions analyst selecting a student's leading activities. Output ONLY the requested JSON array.",
    messages: [{ role: "user", content: prompt }],
  });
  const text = (resp?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const parsed = parseLLMJson(text);
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.activities) ? parsed.activities : []);
  return arr
    .map((it) => ({
      name: String(it?.name || "").trim(),
      lead: Boolean(it?.lead),
      leadScore: Math.max(0, Math.min(1, Number(it?.leadScore))),
      rationale: String(it?.rationale || "").slice(0, 300),
      sources: Array.isArray(it?.sources) ? it.sources.slice(0, 4).map((u) => String(u).slice(0, 400)) : [],
    }))
    .filter((x) => x.name);
}

// Compact deterministic narrative-fit tagger — same model as the candidate
// ranker (bucket hit + theme overlap → predicted tier). Used to annotate
// LLM-generated EC ideas so the student sees how each lands against their
// story without a second LLM call.
function tagIdeaWithNarrative(text, active) {
  if (!active) return { bucketHit: false, themeHits: 0, predictedNarrativeFit: null, predictedTier: null };
  const combined = String(text || "").toLowerCase();
  const narrativeThemes = (active.themes || [])
    .map((th) => (typeof th === "string" ? th : th?.theme))
    .filter(Boolean)
    .map((th) => String(th).toLowerCase());
  const narrativeBuckets = new Set((active.majorBuckets || []).map(String));
  const candidateBucket = matchMajorBucketFn(combined);
  const bucketHit = Boolean(candidateBucket && narrativeBuckets.has(candidateBucket));
  let themeHits = 0;
  for (const theme of narrativeThemes) {
    if (theme.length < 4) continue;
    if (combined.includes(theme)) themeHits += theme.includes(" ") ? 2 : 1;
  }
  const predictedNarrativeFit = Math.round(Math.min(1, (bucketHit ? 0.5 : 0) + Math.min(0.5, themeHits * 0.08)) * 100) / 100;
  let predictedTier = "tier_4_foundational";
  if (bucketHit && themeHits >= 3) predictedTier = "tier_2_strong";
  else if (bucketHit || themeHits >= 4) predictedTier = "tier_3_developing";
  return { bucketHit, themeHits, predictedNarrativeFit, predictedTier };
}

// Build a compact, PII-light profile summary string for generation prompts.
function profileSummaryForPrompt(profile, active) {
  const lines = [];
  if (profile.majorInterest) lines.push(`Intended major: ${profile.majorInterest}`);
  if (profile.gpaUnweighted != null) lines.push(`GPA: ${profile.gpaUnweighted}${profile.gpaWeighted != null ? ` (weighted ${profile.gpaWeighted})` : ""}`);
  const tests = (profile.testScores || []).map(t => `${String(t.test || "").toUpperCase()} ${t.totalScore ?? t.total ?? ""}`.trim()).filter(Boolean);
  if (tests.length) lines.push(`Test scores: ${tests.join(", ")}`);
  const aps = (profile.apScores || []).map(a => `${a.name || a.exam || "AP"}${a.score ? ` (${a.score})` : ""}`).filter(Boolean);
  if (aps.length) lines.push(`AP exams: ${aps.slice(0, 12).join(", ")}`);
  const courses = (profile.courses || []).slice(0, 30).map(c => `${c.name || "?"}${c.type ? ` [${c.type}]` : ""}`);
  if (courses.length) lines.push(`Courses (${(profile.courses || []).length}):\n  ${courses.join("\n  ")}`);
  const acts = (profile.activities || []).slice(0, 20).map(a => `${a.name || "?"} (${a.category || "other"}${a.role ? `, ${a.role}` : ""}) — ${(a.description || "").slice(0, 140)}`);
  if (acts.length) lines.push(`Current activities (${(profile.activities || []).length}):\n  ${acts.join("\n  ")}`);
  const goals = (profile.goals || []).map(g => g.school || g.name).filter(Boolean);
  if (goals.length) lines.push(`Target schools: ${goals.slice(0, 12).join(", ")}`);
  if (active?.themes?.length) {
    const themes = active.themes.map(th => (typeof th === "string" ? th : th?.theme)).filter(Boolean);
    if (themes.length) lines.push(`Narrative themes: ${themes.slice(0, 10).join(", ")}`);
  }
  return lines.join("\n");
}


// Application deadlines cluster Nov–Jan; once they pass, nagging about overdue
// dates for the rest of the cycle is noise. We cull overdue deadlines from the
// surface until Aug 1, when the next application cycle begins and they become
// relevant again (display-only — rows are never deleted, so they re-show then).
const OVERDUE_RESHOW_MONTH = 7; // 0-indexed → August

function shouldCullOverdue(nowMs) {
  return new Date(nowMs ?? Date.now()).getMonth() < OVERDUE_RESHOW_MONTH;
}

function shapeDeadline(row, nowMs) {
  if (!row) return null;
  const due = row.due_at ? new Date(row.due_at).getTime() : null;
  const n = nowMs || Date.now();
  const daysUntil = due != null ? Math.round((due - n) / 86400000) : null;
  let collegeIds = [];
  try { if (row.college_ids_json) collegeIds = JSON.parse(row.college_ids_json); } catch {}
  return {
    id: row.id,
    title: row.title,
    dueAt: row.due_at,
    category: row.category,
    notes: row.notes,
    status: row.status,
    collegeIds,
    daysUntil,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The prestige explanation for a strength row: the row's own read first
// (computed from this student's name, description, awards and attachment
// text), then the shared by-name cache. The cache is keyed by activity name
// across students, so a "Math Team" read from one student's "AIME
// qualifier" description must never explain another student's "Math Team".
function prestigeExplanationFor(row, ecName) {
  const reasoning = row ? safeParseJSON(row.reasoning_json, null)?.prestige : null;
  if (reasoning && (reasoning.rationale || reasoning.catalogMatch)) {
    return {
      score: row.prestige ?? reasoning.score ?? 0,
      source: row.prestige_source || reasoning.source || "unavailable",
      rationale: reasoning.rationale || null,
      sourcesCited: Array.isArray(reasoning.sourcesCited) ? reasoning.sourcesCited : [],
      catalogMatch: reasoning.catalogMatch || null,
      matchedIn: reasoning.matchedIn || null,
      level: reasoning.level || null,
      nextLevel: reasoning.nextLevel || null,
      provider: null,
      model: null,
      fetchedAt: row.updated_at || row.computed_at || null,
    };
  }
  return getPrestigeExplanation(ragStmts, ecName);
}


// GET /api/ec/spike — "Spike Finder": which 2-3 ECs should LEAD the
// application, and which are supporting. Reuses the already-computed EC
// strength vectors (tier_label + major_spike + narrative_fit) — no new
// scoring, just a ranking + a wellbeing read. This is the consultant's
// "depth over breadth" reframing the differentiation strategy calls the
// single highest-leverage EC feature.
const SPIKE_TIER_WEIGHT = Object.freeze({
  tier_1_distinctive: 4,
  tier_2_strong: 3,
  tier_3_developing: 2,
  tier_4_foundational: 1,
});


// GET /api/courses/recommendations — major-aligned course-sequence
// recommender. Diffs the student's transcript against the reference ladder
// for their major bucket, cross-references AP concept-mastery gaps, and
// returns the result in the three trust lanes (verified / inference /
// coaching). This is the differentiation strategy's deepest moat: no
// consumer competitor reasons about academics at course + concept
// resolution.
const COURSE_CONCEPT_GAP_THRESHOLD = 0.45;


// Small helper used by the endpoints above.
function safeParse(json) {
  if (!json) return null;
  if (typeof json !== "string") return json;
  try { return JSON.parse(json); } catch { return null; }
}


// ═══════════════════════════════════════════════════════════
// FIRST-RUN OPERATOR SETUP (localhost + boot console token)
// ═══════════════════════════════════════════════════════════
// Lets an operator finish deployment config from the Setup UI (web /setup.html
// or the macOS app) instead of hand-editing .env:
//   • generate the PII-vault ENCRYPTION_KEY (server-side — the secret is NEVER
//     sent from the client; the client only triggers generation),
//   • save the College Scorecard (IPEDS) data API key.
// Guards: the request must originate from loopback AND carry the one-time
// SETUP_TOKEN printed to the server console at boot. ENCRYPTION_KEY is only
// ever WRITTEN on first run (when not already provided via env) and is NEVER
// rotated here — rotation would orphan all stored PII. Writes go through the
// atomic, backup-taking env-file helpers. Changes require a server restart to
// take effect (secrets are read at boot).

function mapBaselineCollegeSummary(college) {
  return {
    unitId: college.unit_id, name: college.name, state: college.state,
    sat25: college.sat_25, sat75: college.sat_75, act25: college.act_25, act75: college.act_75,
    acceptanceRate: college.acceptance_rate != null ? Math.round(college.acceptance_rate * 1000) / 10 : null,
    enrollment: college.enrollment, tuitionIn: college.tuition_in, tuitionOut: college.tuition_out,
    gradRate: college.grad_rate_6yr, medianEarnings10yr: college.median_earnings_10yr,
    source: "Baseline data (offline mode)",
  };
}

const SCORECARD_QUERY_TTL_DAYS = 7;

function shapeLegacyECVectorFromStrengthRow(row) {
  if (!row) return null;
  const projected = projectStrengthToLegacyVector({
    dedication: row.dedication,
    achievement: row.achievement,
    leadership: row.leadership,
    prestige: row.prestige,
    major_spike: row.major_spike,
    narrative_fit: row.narrative_fit,
  });
  return {
    id: row.id,
    ecName: row.ec_name,
    description: row.description,
    majorContext: null,
    vector: projected.vector,
    composite: projected.composite,
    label: projected.label,
    hoursPerWeek: row.hours_per_week,
    weeksPerYear: row.weeks_per_year,
    yearsActive: row.years_active,
    reasoning: safeParseJSON(row.reasoning_json, {}),
    isOverridden: Boolean(row.is_overridden),
    computedAt: row.computed_at,
    updatedAt: row.updated_at,
    sourceSystem: "ec_strength_vectors",
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeCacheString(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return s || null;
}

function normalizeStateList(states) {
  if (!Array.isArray(states)) return null;
  const normalized = states
    .map((s) => normalizeCacheString(s)?.toUpperCase() || null)
    .filter(Boolean)
    .sort();
  return normalized.length > 0 ? normalized : null;
}

function normalizeScorecardSearchPayload(payload = {}) {
  return {
    name: normalizeCacheString(payload.name),
    state: normalizeCacheString(payload.state)?.toUpperCase() || null,
    states: normalizeStateList(payload.states),
    minSAT: payload.minSAT != null ? Number(payload.minSAT) : null,
    maxTuition: payload.maxTuition != null ? Number(payload.maxTuition) : null,
    maxAcceptanceRate: payload.maxAcceptanceRate != null ? Number(payload.maxAcceptanceRate) : null,
    sizePreference: normalizeCacheString(payload.sizePreference),
    limit: Math.min(Math.max(Number(payload.limit || 20), 1), 100),
    page: Math.max(Number(payload.page || 0), 0),
  };
}

function normalizeUnitId(value) {
  const s = String(value || "").trim();
  return s || null;
}

// Resolve a target school to its baseline_colleges row. Tries, in order:
//   1. exact unit_id
//   2. exact (case-insensitive) name
//   3. conservative fuzzy match on the normalized name
//
// Without (3), a target named "Columbia University" never matches the row
// stored as "Columbia University in the City of New York", so the engine
// silently drops the school's real SAT range + admit rate and falls back to
// optimistic defaults — inflating admissibility. The fuzzy step uses a STRICT
// key (keeps the institution-type word) and only accepts a candidate whose key
// EQUALS the query or is a prefix-extension of it. That matches "Columbia
// University" → "Columbia University in the City of New York" but refuses
// "University of Missouri-Columbia" AND "Boston University" → "Boston College"
// (which would both match if "university"/"college" were stripped).
const BASELINE_PROBE_STOPWORDS = new Set(["university", "college", "of", "the", "and", "institute", "state", "school", "at", "in"]);

function resolveBaselineCollegeRow(database, { unitId, schoolName } = {}) {
  const resolvedUnitId = normalizeUnitId(unitId);
  if (resolvedUnitId) {
    const byId = database.prepare("SELECT * FROM baseline_colleges WHERE unit_id = ?").get(resolvedUnitId);
    if (byId) return byId;
  }
  if (!schoolName) return null;

  const exact = database.prepare("SELECT * FROM baseline_colleges WHERE lower(name) = lower(?) LIMIT 1").get(schoolName);
  if (exact) return exact;

  const query = strictSchoolKey(schoolName);
  if (!query) return null;
  // Narrow with a LIKE on the most distinctive token (longest non-stopword),
  // not "university"/"of" which match thousands of rows.
  const tokens = query.split(" ").filter(Boolean);
  const probe = tokens.filter((t) => !BASELINE_PROBE_STOPWORDS.has(t)).sort((a, b) => b.length - a.length)[0] || tokens[0];
  if (!probe) return null;

  const candidates = database
    .prepare("SELECT * FROM baseline_colleges WHERE lower(name) LIKE ? LIMIT 200")
    .all(`%${probe}%`);

  let best = null;
  let bestScore = -1;
  for (const row of candidates) {
    const cand = strictSchoolKey(row.name);
    if (!cand) continue;
    let score = -1;
    if (cand === query) {
      score = 100;
    } else if (cand.startsWith(`${query} `)) {
      // Prefix extension ("Columbia University" ⊂ "Columbia University in …").
      const extraTokens = cand.split(" ").length - query.split(" ").length;
      score = 80 - Math.min(40, extraTokens);
    } else {
      continue; // distinct school → refuse
    }
    // Tie-break toward rows that actually carry selectivity data.
    if (row.acceptance_rate != null) score += 2;
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return best;
}

function normalizeComparePayload(unitIds) {
  return {
    unitIds: Array.isArray(unitIds)
      ? unitIds.map((id) => normalizeUnitId(id)).filter(Boolean).sort()
      : [],
  };
}

function buildScorecardQueryCacheKey(kind, payload) {
  return crypto
    .createHash("sha256")
    .update(`${kind}|${stableStringify(payload)}`)
    .digest("hex");
}

function pruneScorecardQueryCache() {
  try {
    ragStmts.deleteScorecardQueryCacheOlderThan?.run(`-${SCORECARD_QUERY_TTL_DAYS} days`);
  } catch {
    // Cache pruning is best-effort.
  }
}

function getScorecardQueryCache(kind, payload) {
  pruneScorecardQueryCache();
  const key = buildScorecardQueryCacheKey(kind, payload);
  const row = ragStmts.getScorecardQueryCache?.get(key);
  if (!row) return null;
  return {
    cacheKey: key,
    kind: row.cache_kind,
    fetchedAt: row.fetched_at,
    data: safeJSON(row.data_json, null),
  };
}

function putScorecardQueryCache(kind, payload, data) {
  pruneScorecardQueryCache();
  const key = buildScorecardQueryCacheKey(kind, payload);
  ragStmts.upsertScorecardQueryCache?.run(
    key,
    kind,
    JSON.stringify(payload),
    JSON.stringify(data),
  );
  return key;
}

function collegeMatchesKeyword(college, keyword) {
  const normalized = String(keyword || "").trim().toLowerCase();
  if (!normalized) return true;
  const byName = String(college.name || "").toLowerCase();
  if (byName.includes(normalized)) return true;
  const stopWords = new Set(["of", "the", "and", "at", "for"]);
  const acronym = String(college.name || "").replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).filter(p => !stopWords.has(p.toLowerCase())).map(p => p[0]?.toUpperCase() || "").join("").toLowerCase();
  if (acronym && acronym === normalized.replace(/\./g, "")) return true;
  return byName.replace(/[^a-z0-9]+/g, " ").trim().includes(normalized);
}

function matchesBaselineSizePreference(enrollment, sizePreference) {
  if (enrollment == null || !sizePreference) return true;
  if (sizePreference === "small") return enrollment < 5000;
  if (sizePreference === "medium") return enrollment >= 5000 && enrollment < 20000;
  if (sizePreference === "large") return enrollment >= 20000;
  return true;
}

function buildBaselineCollegeSearchResponse(filters) {
  const safeLimit = Math.min(Math.max(parseInt(filters.limit || "20", 10) || 20, 1), 100);
  const safePage = Math.max(parseInt(filters.page || "0", 10) || 0, 0);
  let colleges = db.prepare("SELECT * FROM baseline_colleges").all();
  if (filters.name) colleges = colleges.filter(c => collegeMatchesKeyword(c, filters.name));
  if (filters.state) colleges = colleges.filter(c => c.state === filters.state);
  if (filters.states?.length) colleges = colleges.filter(c => filters.states.includes(c.state));
  if (filters.minSAT) colleges = colleges.filter(c => (c.sat_75 ?? c.sat_25 ?? null) != null && (c.sat_75 ?? c.sat_25) >= filters.minSAT);
  if (filters.maxTuition) colleges = colleges.filter(c => c.tuition_in != null && c.tuition_in <= filters.maxTuition);
  if (filters.maxAcceptanceRate) colleges = colleges.filter(c => c.acceptance_rate != null && c.acceptance_rate <= filters.maxAcceptanceRate / 100);
  if (filters.sizePreference) colleges = colleges.filter(c => matchesBaselineSizePreference(c.enrollment, filters.sizePreference));

  colleges.sort((a, b) => {
    if (a.acceptance_rate == null && b.acceptance_rate != null) return 1;
    if (a.acceptance_rate != null && b.acceptance_rate == null) return -1;
    if (a.acceptance_rate != null && b.acceptance_rate != null && a.acceptance_rate !== b.acceptance_rate) return a.acceptance_rate - b.acceptance_rate;
    return a.name.localeCompare(b.name);
  });

  const start = safePage * safeLimit;
  return { results: colleges.slice(start, start + safeLimit).map(mapBaselineCollegeSummary), total: colleges.length, page: safePage, source: "Baseline data" };
}

function withScorecardMeta(data, meta = {}) {
  return {
    ...data,
    cached: Boolean(meta.cached),
    stale: Boolean(meta.stale),
    fallback: Boolean(meta.fallback),
    fallbackReason: meta.fallbackReason || null,
    cacheKind: meta.cacheKind || null,
    cacheTtlDays: meta.cacheKind ? SCORECARD_QUERY_TTL_DAYS : null,
    dataFreshness: meta.dataFreshness || (meta.stale ? "stale" : "current"),
  };
}


// ─── Route families (routes/*.js) ─────────────────────────────────────
// The handlers moved out of this file on 2026-09-16 read the server's
// bindings through live getters, so a binding declared or reassigned
// later (the catalog scout's list, the pillar auth) is current at request
// time. Registration order among a family's routes is unchanged; the
// families register here, after every route that stayed and before the
// health route, the pillar mount, the static files and the error handler.
const routeDeps = {
  get ADMIN_COOKIE() { return ADMIN_COOKIE; },
  get CHAT_EXTRACT_MAX_BYTES() { return CHAT_EXTRACT_MAX_BYTES; },
  get COURSE_CONCEPT_GAP_THRESHOLD() { return COURSE_CONCEPT_GAP_THRESHOLD; },
  get DATA_DIR() { return DATA_DIR; },
  get ENCRYPTION_KEY() { return ENCRYPTION_KEY; },
  get MAX_TOKENS_LIMIT() { return MAX_TOKENS_LIMIT; },
  get OPERATOR_LLM() { return OPERATOR_LLM; },
  get RETENTION_MODE() { return RETENTION_MODE; },
  get SCORECARD_API_KEY() { return SCORECARD_API_KEY; },
  get SCOUT_CADENCE_DAYS() { return SCOUT_CADENCE_DAYS; },
  get SPIKE_TIER_WEIGHT() { return SPIKE_TIER_WEIGHT; },
  get WEB_CONFIG_KEY() { return WEB_CONFIG_KEY; },
  get WEB_DEPLOYMENT() { return WEB_DEPLOYMENT; },
  get WEB_SECRETS_READY() { return WEB_SECRETS_READY; },
  get adminAuthLimiter() { return adminAuthLimiter; },
  get adminModelsPayload() { return adminModelsPayload; },
  get adminSessionResponse() { return adminSessionResponse; },
  get admissionsIntelStmts() { return admissionsIntelStmts; },
  get apiLimiter() { return apiLimiter; },
  get assembleProfileForGeneration() { return assembleProfileForGeneration; },
  get authLimiter() { return authLimiter; },
  get authStore() { return authStore; },
  get baselineCollegeNames() { return baselineCollegeNames; },
  get bearerToken() { return bearerToken; },
  get buildAdmissionsCalendar() { return buildAdmissionsCalendar; },
  get buildBaselineCollegeSearchResponse() { return buildBaselineCollegeSearchResponse; },
  get buildStudentCallLLM() { return buildStudentCallLLM; },
  get buildVerifiedDataContext() { return buildVerifiedDataContext; },
  get callSimulationSidecar() { return callSimulationSidecar; },
  get chatGraphStmts() { return chatGraphStmts; },
  get clearAdminCookie() { return clearAdminCookie; },
  get collectStudentRows() { return collectStudentRows; },
  get collegeResearchStmts() { return collegeResearchStmts; },
  get createSessionToken() { return createSessionToken; },
  get db() { return db; },
  get deadlinesFromResearchCache() { return deadlinesFromResearchCache; },
  get deleteStudentRows() { return deleteStudentRows; },
  get ecUpload() { return ecUpload; },
  get evidenceStmts() { return evidenceStmts; },
  get factStmts() { return factStmts; },
  get fitMatrixOptions() { return fitMatrixOptions; },
  get generateNarrativeDraftText() { return generateNarrativeDraftText; },
  get getSchoolPriorities() { return getSchoolPriorities; },
  get getScorecardQueryCache() { return getScorecardQueryCache; },
  get hasAllowedAdminOrigin() { return hasAllowedAdminOrigin; },
  get hasDesktopBootstrapProof() { return hasDesktopBootstrapProof; },
  get hasVerifiedCollegeData() { return hasVerifiedCollegeData; },
  get hashEmail() { return hashEmail; },
  get hashIP() { return hashIP; },
  get inlineAttachmentBlocks() { return inlineAttachmentBlocks; },
  get llmRankCandidates() { return llmRankCandidates; },
  get llmRankSpike() { return llmRankSpike; },
  get llmResponseText() { return llmResponseText; },
  get maybeAutoRegenerateNarrative() { return maybeAutoRegenerateNarrative; },
  get maybeRunModelCatalogScout() { return maybeRunModelCatalogScout; },
  get messageText() { return messageText; },
  get modelCatalogStmts() { return modelCatalogStmts; },
  get normalizeComparePayload() { return normalizeComparePayload; },
  get normalizeScorecardSearchPayload() { return normalizeScorecardSearchPayload; },
  get normalizeUnitId() { return normalizeUnitId; },
  get orchestrationCatalog() { return orchestrationCatalog; },
  get parseLLMJson() { return parseLLMJson; },
  get piiStmts() { return piiStmts; },
  get piiVault() { return piiVault; },
  get policyScoutRunning() { return policyScoutRunning; },
  get policyScoutSchedule() { return policyScoutSchedule; },
  get policyScoutStmts() { return policyScoutStmts; },
  get prestigeExplanationFor() { return prestigeExplanationFor; },
  get profileSummaryForPrompt() { return profileSummaryForPrompt; },
  get putScorecardQueryCache() { return putScorecardQueryCache; },
  get queueChatEvidence() { return queueChatEvidence; },
  get ragStmts() { return ragStmts; },
  get readCookie() { return readCookie; },
  get recomputeStrengthForStudent() { return recomputeStrengthForStudent; },
  get regulatedChatGate() { return regulatedChatGate; },
  get regulatedResultForChat() { return regulatedResultForChat; },
  get rememberFitRead() { return rememberFitRead; },
  get removeStudentFiles() { return removeStudentFiles; },
  get requireAdminNetwork() { return requireAdminNetwork; },
  get requireCounselorAuth() { return requireCounselorAuth; },
  get requireStudentAuth() { return requireStudentAuth; },
  get requireWebConfiguration() { return requireWebConfiguration; },
  get resolveBaselineCollegeRow() { return resolveBaselineCollegeRow; },
  get resolvePrestigeAdapter() { return resolvePrestigeAdapter; },
  get resolveTargetSchools() { return resolveTargetSchools; },
  get respondLLMError() { return respondLLMError; },
  get runPositioning() { return runPositioning; },
  get runScheduledPolicyScout() { return runScheduledPolicyScout; },
  get safeJSON() { return safeJSON; },
  get safeParse() { return safeParse; },
  get safeParseJSON() { return safeParseJSON; },
  get scheduleWebConfigurationRestart() { return scheduleWebConfigurationRestart; },
  get schoolPrioritiesPromptBlock() { return schoolPrioritiesPromptBlock; },
  get scorecardLimiter() { return scorecardLimiter; },
  get scorecardStatsOnDemand() { return scorecardStatsOnDemand; },
  get scoutSchoolOnDemand() { return scoutSchoolOnDemand; },
  get shapeDeadline() { return shapeDeadline; },
  get shapeLegacyECVectorFromStrengthRow() { return shapeLegacyECVectorFromStrengthRow; },
  get shouldCullOverdue() { return shouldCullOverdue; },
  get snapshotToStudentProfile() { return snapshotToStudentProfile; },
  get stmts() { return stmts; },
  get studentLimiter() { return studentLimiter; },
  get tagIdeaWithNarrative() { return tagIdeaWithNarrative; },
  get validateAdminSecret() { return validateAdminSecret; },
  get vectorStmts() { return vectorStmts; },
  get vectorStore() { return vectorStore; },
  get withScorecardMeta() { return withScorecardMeta; },
};
registerMethodologyRoutes(app, routeDeps);
registerContextRoutes(app, routeDeps);
registerChatRoutes(app, routeDeps);
registerAgentsRoutes(app, routeDeps);
registerCdsRoutes(app, routeDeps);
registerAdmissionsPolicyRoutes(app, routeDeps);
registerAdminRoutes(app, routeDeps);
registerStudentsRoutes(app, routeDeps);
registerCollegesRoutes(app, routeDeps);
registerRagRoutes(app, routeDeps);
registerPositioningRoutes(app, routeDeps);
registerSimulationsRoutes(app, routeDeps);
registerEcRoutes(app, routeDeps);
registerFilesRoutes(app, routeDeps);
registerNarrativeRoutes(app, routeDeps);
registerDirectionalityRoutes(app, routeDeps);
registerApConceptsRoutes(app, routeDeps);
registerCoursesRoutes(app, routeDeps);
registerCalendarRoutes(app, routeDeps);
registerMcpRoutes(app, routeDeps);
registerBaselinesRoutes(app, routeDeps);
registerConsentRoutes(app, routeDeps);
registerAdmissionsIntelRoutes(app, routeDeps);

app.get("/api/health", (_req, res) => {
  const crisisCount = stmts.getCrisisCount24h.get();
  res.json(buildHealthResponse({
    production: NODE_ENV === "production",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    details: {
      scorecard: !!SCORECARD_API_KEY,
      crisisLast24h: crisisCount.count,
      retentionMode: RETENTION_MODE,
      databases: { operational: "counselor.db", piiVault: "pii-vault.db", vectors: "vectors.db" },
    },
  }));
});


// ═══════════════════════════════════════════════════════════
// COUNSELOR DASHBOARD (HTML UI)
// ═══════════════════════════════════════════════════════════

// PILLAR ROUTES (knowledge graph and Strategy Council)
// ═══════════════════════════════════════════════════════════
// Mounted before the static catch-all so /api/* paths resolve here. All
// The routes are mounted before the static catch-all and use the shared
// authenticated-student boundary.
try {
  // Bridge the existing requireStudentAuth (sets req.studentId) to the shape
  // the pillar routes expect (req.user.studentId).
  const requireAuthBridge = (req, res, next) =>
    requireStudentAuth(req, res, () => {
      req.user = req.user || {};
      if (req.studentId && !req.user.studentId) req.user.studentId = req.studentId;
      next();
    });

  const councilBudgetStages = Object.freeze([
    { index: 0, role: "Strategist", tier: "small" },
    { index: 1, role: "Data Checker", tier: "medium" },
    { index: 2, role: "Skeptic", tier: "small" },
    { index: 3, role: "Devil's Advocate", tier: "small" },
    { index: 4, role: "Moderator", tier: "none", deterministic: true },
  ]);

  function beginCouncilBudget({ studentId, operationId }) {
    const grade = authStore.getStudentGrade(studentId);
    const session = {
      studentId,
      operationId,
      stages: councilBudgetStages.map((stage) => ({ ...stage })),
    };
    try {
      for (const stage of session.stages.filter((item) => !item.deterministic)) {
        const model = OPENROUTER_TARGETS[stage.tier];
        const reservation = reserveBudget(db, {
          studentId,
          grade,
          requestId: "council:" + studentId + ":" + operationId + ":" + stage.index,
          model,
          maxInputTokens: 8_000,
          maxOutputTokens: 600,
        });
        if (!reservation.allowed || reservation.idempotent) {
          const error = new Error(reservation.idempotent
            ? "The internal Council budget reservation conflicted."
            : (reservation.reason || "The full Council request exceeds the remaining monthly budget."));
          error.status = reservation.idempotent ? 500 : 402;
          error.code = reservation.idempotent ? "council_budget_conflict" : (reservation.code || "council_budget_denied");
          throw error;
        }
        stage.model = model;
        stage.reservation = reservation;
      }
      return session;
    } catch (error) {
      for (const stage of session.stages) releaseStudentModelCall(stage.reservation);
      throw error;
    }
  }

  mountPillarRoutes(app, {
    db,
    dataDir: DATA_DIR,
    requireAuth: requireAuthBridge,
    requireSelf,
    studentLimiter,
    factStmts,
    evidenceStmts,
    getOperatorLLM: currentOperatorKeyConfig,
    validateAIConsent: (studentId) => validateRequiredConsents(piiStmts, studentId, "ai_interaction"),
    getStudentProfile: (studentId) => {
      try {
        const snap = ragStmts.getLatestSnapshot.get(studentId);
        return snap || null;
      } catch {
        return null;
      }
    },
    beginCouncilBudget,
    beforeCouncilStage: ({ index, budgetSession }) => {
      const stage = budgetSession?.stages?.find((item) => item.index === index);
      return stage?.reservation
        ? { allowed: true, reservationId: stage.reservation.reservationId }
        : { allowed: false, code: "COUNCIL_BUDGET_DENIED", reason: "Council stage was not pre-reserved." };
    },
    afterCouncilStage: ({ index, output, budgetSession }) => {
      const stage = budgetSession?.stages?.find((item) => item.index === index);
      if (!stage?.reservation) return { ok: false, code: "reservation_not_found" };
      stage.usage = output?.usage || null;
      stage.reconciliation = reconcileStudentModelCall(stage.reservation, output?.usage);
      return stage.reconciliation;
    },
    releaseCouncilBudget: (budgetSession) => {
      for (const stage of budgetSession?.stages || []) {
        if (stage.reservation && !stage.reconciliation) releaseStudentModelCall(stage.reservation);
      }
    },
  });
  console.log("[BOOT] Knowledge-graph and explicit Council routes mounted.");
} catch (err) {
  console.error("[BOOT] Failed to mount pillar routes:", err.message);
}


// ═══════════════════════════════════════════════════════════
// SERVE FRONTEND (production static files)
// ═══════════════════════════════════════════════════════════
const publicDir = process.env.PUBLIC_DIR ? path.resolve(process.env.PUBLIC_DIR) : path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  // Express 5 (path-to-regexp 8) names its wildcards: "*" became "/{*splat}".
  app.get("/{*splat}", (req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    res.sendFile(path.join(publicDir, "index.html"));
  });
} else {
  console.warn("[BOOT] No ./public directory — frontend not served.");
  app.get("/", (_req, res) => res.json({ status: "Backend running. Build frontend into ./public to serve it." }));
}


// ═══════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ═══════════════════════════════════════════════════════════
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err.message);
  res.status(err.status || 500).json({
    error: NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});


// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════
app.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  College Counselor Backend v2 (Rules-First Architecture)       ║
║  Port: ${String(PORT).padEnd(54)}║
║  Env:  ${NODE_ENV.padEnd(54)}║
║  Scorecard: ${(SCORECARD_API_KEY ? "LIVE" : "OFFLINE (baseline only)").padEnd(49)}║
║  Retention: ${RETENTION_MODE.padEnd(49)}║
║                                                                ║
║  Databases:                                                    ║
║    counselor.db  — operational (audit, baselines, snapshots)   ║
║    pii-vault.db  — encrypted PII (separate, AES-256-GCM)      ║
║    vectors.db    — embeddings (no student PII)                 ║
║                                                                ║
║  Architecture:                                                 ║
║    T0: Rules Engine (deterministic, $0)                        ║
║    T1: Small (routine coaching)                                ║
║    T2: Medium (synthesis and strategy)                         ║
║    T3: Large (complex review)                                  ║
║    Paid calls share a fixed grade-based monthly budget.        ║
║                                                                ║
║  New Modules:                                                  ║
║    policy-router, rules-engine, fact-store, evidence-graph,    ║
║    answer-composer, pii-vault, content-mod,                    ║
║    consent, domain-monitor, retention, batch-jobs, vector-store║
╚════════════════════════════════════════════════════════════════╝
  `);
});


// ═══════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════
// Whatever happens below, the process exits: Render and the route tests both
// wait for it. db.close() throws while the boot-time CDS seeding still has a
// statement running (a SIGTERM two seconds after boot, as in a route test's
// teardown), and with the rejection guard below that no longer ends the
// process by itself — CI hung on it on 2026-09-16 (Windows kills the child
// outright, so local runs never reach this handler).
async function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received. Stopping jobs and closing databases...`);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  try {
    stopAllJobs();
    for (const [name, close] of [["counselor.db", () => db.close()], ["pii-vault.db", () => piiVault.close()], ["vectors.db", () => vectorStore.close()]]) {
      try { close(); } catch (err) { console.warn(`[SHUTDOWN] ${name} did not close cleanly: ${err.message}`); }
    }
    console.log("[SHUTDOWN] All databases closed. Exiting.");
    process.exit(0);
  } catch (err) {
    console.error("[SHUTDOWN] failed:", err.message);
    process.exit(1);
  }
}

// A rejected promise nobody awaits would end the process (Node's default).
// pdfjs can reject one after a document is torn down while the daily CDS
// refresh parses hundreds of files (seen on the 2026-09-16 whole-index run:
// "AbortException: Value is none of these types"), which must not take the
// counselor down; the pipeline already reports per-school failures. Log it.
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason && reason.message ? reason.message : String(reason));
});
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
