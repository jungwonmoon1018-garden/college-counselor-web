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
import { initFactStore, prepareFactStatements, seedCollegeFacts } from "./scouts/fact-store.js";
import {
  initEvidenceGraph,
  prepareEvidenceStatements,
  seedECBenchmarkEvidence,
  seedCollegeEvidence,
  seedCompetitiveActivityEvidence,
} from "./storage/evidence-graph.js";
import { initPIIVault, preparePIIStatements } from "./storage/pii-vault.js";
import { initUsageBudget, reserveBudget } from "./security/usage-budget.js";
import {
  OPENROUTER_TARGETS,
  OPENROUTER_CATALOG,
  refreshOpenRouterTargets,
  refreshOpenRouterCatalog,
  configureOpenRouterCatalogCache,
} from "./scouts/openrouter-model-refresh.js";
import * as chatHistory from "./chat/chat-history.js";
import { registerDynamicOpenRouterModels as adapterRegisterDynamicModels } from "./llm-adapters/index.js";
import { validateRequiredConsents } from "./security/consent.js";
import { initDomainMonitor, prepareMonitorStatements } from "./colleges/domain-monitor.js";
import { initCollegeResearch } from "./colleges/college-research.js";
import "./storage/retention.js";
import { registerStandardJobs, registerJob, startAllJobs, stopAllJobs } from "./scouts/batch-jobs.js";
import { initVectorStore, prepareVectorStatements } from "./storage/vector-store.js";
import { initRAGTables, seedBaselines, prepareRAGStatements, extractGoalUnitIds } from "./storage/rag-engine.js";
import { mountPillarRoutes } from "./routes/server-routes-pillars.js";
import { refreshAllCds, shouldRunCdsRefresh } from "./cds/cds-ingest-pipeline.js";
import { seedAPConceptCatalog } from "./academics/ap-concept-vectorizer.js";
import multer from "multer";
// F6 uses the same major-bucket matcher as the EC vectorizer to score
// candidate EC ideas against the student's active narrative.
import { isSupportedMime, MAX_FILE_BYTES } from "./shared/file-extractors.js";
import { detectSchoolMentions } from "./chat/chat-grounding.js";
import * as chatGraph from "./chat/chat-graph.js";
import {
  SCOUT_VERSION,
  initPolicyScout,
  preparePolicyScoutStatements,
  runPolicyScout,
  lastAutomaticRun,
} from "./scouts/admissions-policy-scout.js";
import { GPA_BASELINES, SAT_BASELINES, ACT_BASELINES, EC_BENCHMARKS, COLLEGE_PROFILES, COMPETITIVE_ACTIVITY_BENCHMARKS } from "./colleges/baseline-data.js";
import { extractTargetSchoolNames } from "./cds/cds-search.js";
import { ensureCdsStoreSeeded } from "./cds/cds-store.js";
import { initAdmissionsIntelligenceTables, prepareAdmissionsIntelStatements, seedOfficialCipMappings } from "./colleges/admissions-intelligence.js";
import "./colleges/admissions-intelligence-loader.js";
import { loadOrchestrationCatalog } from "./chat/orchestration-engine.js";
import { initAuthStore } from "./security/security-auth.js";
import { ADMIN_AUTH_RATE_LIMIT, AUTH_RATE_LIMIT, buildHealthResponse, securityResponseMiddleware } from "./security/security-hardening.js";
import { OPENROUTER_MODEL_OPTIONS } from "./llm-adapters/tier-defaults.js";
import {
  initModelCatalogScout,
  prepareModelCatalogStatements,
  runModelCatalogScout,
  listDynamicModelOptions,
  dynamicAllowedModelIds,
  lastModelCatalogRun,
  MODEL_SCOUT_VERSION,
} from "./scouts/model-catalog-scout.js";
import { scoutCadenceMs, scoutRunDue, cadenceDays, SCOUT_DUE_CHECK_MS } from "./scouts/scout-cadence.js";
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
import { registerEcNarrativeRoutes } from "./routes/ec-narrative.js";
import { registerEcStrengthRoutes } from "./routes/ec-strength.js";
import { registerEcResearchRoutes } from "./routes/ec-research.js";
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
import { bindAuth, createSessionToken, hashIP, hashEmail, safeJSON, requireStudentAuth, requireSelf, bearerToken, readCookie, clearAdminCookie, isAllowedRequestOrigin, hasAllowedAdminOrigin, hasDesktopBootstrapProof, requireAdminNetwork, requireCounselorAuth, adminSessionResponse, validateAdminSecret, requireWebConfiguration, scheduleWebConfigurationRestart } from "./server/auth.js";
import {
  bindModelCalls,
  snapshotToStudentProfile,
  callSimulationSidecar,
  resolvePrestigeAdapter,
  reconcileStudentModelCall,
  releaseStudentModelCall,
  currentOperatorKeyConfig,
  buildStudentCallLLM,
  parseLLMJson,
  respondLLMError,
  llmResponseText,
  safeParseJSON,
} from "./server/model-calls.js";
import { bindVerifiedData, regulatedChatGate, scoutSchoolOnDemand, scorecardStatsOnDemand, assembleProfileForGeneration, fitMatrixOptions, baselineCollegeNames, buildVerifiedDataContext, hasVerifiedCollegeData, regulatedResultForChat, deadlinesFromResearchCache, rememberFitRead } from "./server/verified-data.js";
import { bindNarrativeCalendar, generateNarrativeDraftText, maybeAutoRegenerateNarrative, resolveTargetSchools, getSchoolPriorities, schoolPrioritiesPromptBlock, buildAdmissionsCalendar } from "./server/narrative-calendar.js";
import { bindChatAttachments, messageText, inlineAttachmentBlocks, queueChatEvidence, recomputeStrengthForStudent } from "./server/chat-attachments.js";
import { bindStudentData, collectStudentRows, deleteStudentRows, removeStudentFiles } from "./server/student-data.js";
import { bindPositioning, runPositioning } from "./server/positioning.js";
import { bindEcRanking, llmRankCandidates, llmRankSpike, tagIdeaWithNarrative, profileSummaryForPrompt, shouldCullOverdue, shapeDeadline, prestigeExplanationFor, shapeLegacyECVectorFromStrengthRow } from "./server/ec-ranking.js";
import { bindBaselineColleges, safeParse, normalizeScorecardSearchPayload, normalizeUnitId, resolveBaselineCollegeRow, normalizeComparePayload, getScorecardQueryCache, putScorecardQueryCache, buildBaselineCollegeSearchResponse, withScorecardMeta } from "./server/baseline-colleges.js";

// ─── routeDeps ────────────────────────────────────────────────────────
// Live getters onto this module's bindings, read by the route families
// (routes/*.js) and by the helper modules (server/*.js) that moved out of
// this file. A getter runs when it is read, so the object can sit above the
// declarations it names: a binding is current at request time, and a read
// before its declaration fails exactly as the direct reference did. The
// bind calls come first of all because an imported helper, like the hoisted
// function it replaces, may be called from any line below.
const routeDeps = {
  get ADMIN_COOKIE() { return ADMIN_COOKIE; },
  get ALLOWED_ORIGINS() { return ALLOWED_ORIGINS; },
  get AUTO_NARRATIVE_TRIGGERS() { return AUTO_NARRATIVE_TRIGGERS; },
  get BASELINE_PROBE_STOPWORDS() { return BASELINE_PROBE_STOPWORDS; },
  get C7_PRIORITY_WEIGHTS() { return C7_PRIORITY_WEIGHTS; },
  get CDS_LIVE_COOLDOWN_MS() { return CDS_LIVE_COOLDOWN_MS; },
  get CHAT_EXTRACT_MAX_BYTES() { return CHAT_EXTRACT_MAX_BYTES; },
  get COURSE_CONCEPT_GAP_THRESHOLD() { return COURSE_CONCEPT_GAP_THRESHOLD; },
  get DATA_DIR() { return DATA_DIR; },
  get EC_ATTACHMENTS_DIR() { return EC_ATTACHMENTS_DIR; },
  get ENCRYPTION_KEY() { return ENCRYPTION_KEY; },
  get LOCALHOST_ORIGIN_RE() { return LOCALHOST_ORIGIN_RE; },
  get MAX_TOKENS_LIMIT() { return MAX_TOKENS_LIMIT; },
  get NODE_ENV() { return NODE_ENV; },
  get OPERATOR_LLM() { return OPERATOR_LLM; },
  get OVERDUE_RESHOW_MONTH() { return OVERDUE_RESHOW_MONTH; },
  get RANK_TIERS() { return RANK_TIERS; },
  get RETENTION_MODE() { return RETENTION_MODE; },
  get SCORECARD_API_KEY() { return SCORECARD_API_KEY; },
  get SCORECARD_QUERY_TTL_DAYS() { return SCORECARD_QUERY_TTL_DAYS; },
  get SCOUT_CADENCE_DAYS() { return SCOUT_CADENCE_DAYS; },
  get SIM_INTERNAL_TOKEN() { return SIM_INTERNAL_TOKEN; },
  get SIM_URL() { return SIM_URL; },
  get SPIKE_TIER_WEIGHT() { return SPIKE_TIER_WEIGHT; },
  get TOKEN_TTL_MS() { return TOKEN_TTL_MS; },
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
  get cdsLiveAttemptAt() { return cdsLiveAttemptAt; },
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
  get fitReadStmts() { return fitReadStmts; },
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
  get onDemandScouts() { return onDemandScouts; },
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
  get sessionStmts() { return sessionStmts; },
  get sessionTokens() { return sessionTokens; },
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
bindAuth(routeDeps);
bindModelCalls(routeDeps);
bindVerifiedData(routeDeps);
bindNarrativeCalendar(routeDeps);
bindChatAttachments(routeDeps);
bindStudentData(routeDeps);
bindPositioning(routeDeps);
bindEcRanking(routeDeps);
bindBaselineColleges(routeDeps);

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
    const { ingestBulk, getRepositoryIndex } = await import("./cds/cds-ingest-pipeline.js");
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


setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessionTokens) {
    if (now > session.expiresAt) sessionTokens.delete(token);
  }
  try { sessionStmts.cleanup.run(now); } catch {}
}, 10 * 60 * 1000);


const ADMIN_COOKIE = "cc_admin_session";


// On-demand official reads for a pure lookup about a school we hold nothing
// for: the school's own admissions pages (the policy scout's reader, which
// also stores the snapshot for later turns) or the College Scorecard for
// admissions statistics. Bounded so a slow site cannot stall the chat; a
// read that outlives the wait finishes in the background.
const onDemandScouts = new Map();


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


// For each target school, pull its REAL, citeable priorities from the
// validated Common Data Set (C7 factor weights + admit context). Name-only
// fallback when there's no validated record. Async (dynamic CDS import,
// matching the bundle's pattern).
const C7_PRIORITY_WEIGHTS = Object.freeze({ very_important: 1.0, important: 0.7, considered: 0.35, not_considered: 0.0 });


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


// Opportunistic live CDS search: when a searched school is not already in the
// validated store, fetch + parse + persist its Common Data Set via the live
// repository pipeline so College Fit can ground in real numbers next time.
// Best-effort and time-boxed; a per-slug cooldown prevents re-fetching schools
// that aren't in the repository (or whose PDFs won't parse) on every request.
const cdsLiveAttemptAt = new Map(); // slug -> epoch ms of last attempt
const CDS_LIVE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours


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


// Application deadlines cluster Nov–Jan; once they pass, nagging about overdue
// dates for the rest of the cycle is noise. We cull overdue deadlines from the
// surface until Aug 1, when the next application cycle begins and they become
// relevant again (display-only — rows are never deleted, so they re-show then).
const OVERDUE_RESHOW_MONTH = 7; // 0-indexed → August


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


const SCORECARD_QUERY_TTL_DAYS = 7;


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


// ─── Route families (routes/*.js) ─────────────────────────────────────
// The handlers moved out of this file on 2026-09-16 read the server's
// bindings through live getters, so a binding declared or reassigned
// later (the catalog scout's list, the pillar auth) is current at request
// time. Registration order among a family's routes is unchanged; the
// families register here, after every route that stayed and before the
// health route, the pillar mount, the static files and the error handler.
// routeDeps itself is declared under the imports.
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
registerEcNarrativeRoutes(app, routeDeps);
registerEcStrengthRoutes(app, routeDeps);
registerEcResearchRoutes(app, routeDeps);
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
