// routes/admin.js — the /api/admin routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (ADMIN_COOKIE, DATA_DIR, ENCRYPTION_KEY, OPERATOR_LLM, SCORECARD_API_KEY, SCOUT_CADENCE_DAYS, WEB_CONFIG_KEY, WEB_DEPLOYMENT, WEB_SECRETS_READY, adminAuthLimiter, adminModelsPayload, adminSessionResponse, authStore, baselineCollegeNames, clearAdminCookie, db, hasAllowedAdminOrigin, hasDesktopBootstrapProof, maybeRunModelCatalogScout, modelCatalogStmts, policyScoutRunning, policyScoutSchedule, policyScoutStmts, readCookie, requireAdminNetwork, requireCounselorAuth, requireWebConfiguration, resolveBaselineCollegeRow, runScheduledPolicyScout, safeParseJSON, scheduleWebConfigurationRestart, studentLimiter, validateAdminSecret).
import { lastRunSummary, listRecentChanges } from "../scouts/admissions-policy-scout.js";
import { detectSchoolMentions } from "../chat/chat-grounding.js";
import { mergeWebModels, mergeWebSecret, readWebSecretConfig, writeWebSecretConfig } from "../security/web-secret-store.js";
import { dynamicAllowedModelIds, setModelCandidateStatus } from "../scouts/model-catalog-scout.js";
import { registerDynamicOpenRouterModels as adapterRegisterDynamicModels } from "../llm-adapters/index.js";
import { OPENROUTER_MODEL_OPTIONS } from "../llm-adapters/tier-defaults.js";
import fs from "node:fs";
import path from "node:path";
import { BACKUP_FILE_RE, listBackupFiles } from "../storage/db-backup.js";

// The store, or a fresh one when the store on the disk was written under
// another WEB_CONFIG_KEY (a rotation without WEB_CONFIG_KEY_PREVIOUS): the
// counselor is re-entering the secrets, and the first one saved starts the
// store again instead of every save failing with 500.
function readOrStartWebConfig(deps) {
  try {
    return readWebSecretConfig({ dataDir: deps.DATA_DIR, configKey: deps.WEB_CONFIG_KEY });
  } catch (error) {
    if (error.code !== "web_config_unreadable") throw error;
    console.warn("[ADMIN] The stored configuration is unreadable under this WEB_CONFIG_KEY; starting it again with what is being saved.");
    return { secrets: {}, models: {} };
  }
}

const CONFIG_UNREADABLE_HELP = "The stored configuration was written under a different WEB_CONFIG_KEY. Restore that key, set WEB_CONFIG_KEY_PREVIOUS to it for one deploy so the store is re-wrapped, or re-enter every secret here.";

export function registerAdminRoutes(app, deps) {
  app.get("/api/admin/policy-scout/status", deps.studentLimiter, deps.requireCounselorAuth, (_req, res) => {
    try {
      res.json({
        running: Boolean(deps.policyScoutRunning),
        cadenceDays: deps.SCOUT_CADENCE_DAYS,
        nextRunAt: deps.policyScoutSchedule().nextRunAt,
        lastRun: lastRunSummary(deps.policyScoutStmts),
        runs: deps.policyScoutStmts.listRuns.all(10).map((row) => ({
          id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, trigger: row.trigger,
          schoolsTotal: row.schools_total, schoolsChecked: row.schools_checked, schoolsFailed: row.schools_failed, changes: row.changes,
          summary: deps.safeParseJSON(row.summary_json, null),
        })),
        recentChanges: listRecentChanges(deps.policyScoutStmts, { days: 30, limit: 100 }),
        snapshots: deps.policyScoutStmts.listSnapshots.all(200).map((row) => ({
          school: row.school_name, slug: row.slug, unitId: row.unit_id, checkedAt: row.checked_at, changedAt: row.changed_at, checks: row.check_count,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: "Policy scout status failed", message: String(err.message).slice(0, 200) });
    }
  });

  // Manual trigger. A short explicit list (≤ 5 schools) runs synchronously and
  // returns the summary; otherwise the full daily set runs in the background.
  app.post("/api/admin/policy-scout/run", deps.studentLimiter, deps.requireCounselorAuth, async (req, res) => {
    try {
      const requested = Array.isArray(req.body?.schools)
        ? req.body.schools.map((s) => String(s?.name || s || "").trim().slice(0, 120)).filter(Boolean)
        : [];
      if (requested.length && requested.length <= 5) {
        const knownNames = deps.baselineCollegeNames();
        const targets = requested.map((name) => {
          const canonical = detectSchoolMentions(name, { knownNames, max: 1 })[0] || name;
          const row = deps.resolveBaselineCollegeRow(deps.db, { schoolName: canonical });
          return { name: row?.name || canonical, unitId: row?.unit_id || null, website: row?.website || null };
        });
        const summary = await deps.runScheduledPolicyScout("manual", { targets, maxSchools: 5 });
        return res.json({ ok: true, ...summary });
      }
      if (deps.policyScoutRunning) return res.status(409).json({ error: "A policy scout run is already in progress.", code: "already_running" });
      deps.runScheduledPolicyScout("manual").catch((err) => console.warn("[policy-scout] manual run failed:", err?.message));
      res.status(202).json({ ok: true, started: true });
    } catch (err) {
      console.error("[policy-scout] manual run failed:", err.message);
      res.status(500).json({ error: "Policy scout run failed" });
    }
  });

  app.get("/api/admin/status", deps.studentLimiter, deps.requireAdminNetwork, (_req, res) => {
    res.json({
      bootstrapped: deps.authStore.adminBootstrapped(),
      webDeployment: deps.WEB_DEPLOYMENT,
      installationReady: deps.WEB_SECRETS_READY,
    });
  });

  app.post("/api/admin/bootstrap", deps.adminAuthLimiter, deps.requireAdminNetwork, (req, res) => {
    if (!deps.hasDesktopBootstrapProof(req)) return res.status(403).json({
      error: deps.WEB_DEPLOYMENT ? "The website setup token is invalid." : "Privileged desktop bootstrap proof required.",
    });
    if (!deps.hasAllowedAdminOrigin(req)) return res.status(403).json({ error: "Administrator origin is not allowed." });
    try {
      return deps.adminSessionResponse(req, res, deps.authStore.bootstrapAdmin(req.body?.password), 201);
    } catch (err) {
      if (err.code === "admin_exists") return res.status(409).json({ error: err.message, code: err.code });
      if (err.code === "invalid_password") return res.status(400).json({ error: err.message, code: err.code });
      return res.status(500).json({ error: "Administrator setup failed." });
    }
  });

  app.post("/api/admin/login", deps.adminAuthLimiter, deps.requireAdminNetwork, (req, res) => {
    if (!deps.hasAllowedAdminOrigin(req)) return res.status(403).json({ error: "Administrator origin is not allowed." });
    const result = deps.authStore.authenticateAdmin(req.body?.password);
    if (!result) return res.status(401).json({ error: "Invalid administrator credentials." });
    return deps.adminSessionResponse(req, res, result);
  });

  app.post("/api/admin/recover", deps.adminAuthLimiter, deps.requireAdminNetwork, (req, res) => {
    if (!deps.WEB_DEPLOYMENT && !deps.hasDesktopBootstrapProof(req)) return res.status(403).json({ error: "Privileged desktop recovery proof required." });
    if (!deps.hasAllowedAdminOrigin(req)) return res.status(403).json({ error: "Administrator origin is not allowed." });
    try {
      const result = deps.authStore.recoverAdmin(req.body?.recoveryCode, req.body?.newPassword);
      if (!result) return res.status(400).json({ error: "Recovery information is invalid.", code: "invalid_recovery" });
      return deps.adminSessionResponse(req, res, result);
    } catch (err) {
      if (err.code === "invalid_password") return res.status(400).json({ error: err.message, code: err.code });
      return res.status(500).json({ error: "Administrator recovery failed." });
    }
  });

  app.get("/api/admin/session", deps.studentLimiter, deps.requireCounselorAuth, (_req, res) => {
    res.json({ authenticated: true });
  });

  app.post("/api/admin/authorize", deps.studentLimiter, deps.requireCounselorAuth, (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/admin/logout", deps.studentLimiter, deps.requireCounselorAuth, (req, res) => {
    deps.authStore.revokeAdminSession(deps.readCookie(req, deps.ADMIN_COOKIE));
    deps.clearAdminCookie(req, res);
    res.json({ loggedOut: true });
  });

  app.post("/api/admin/logout-all", deps.studentLimiter, deps.requireCounselorAuth, (req, res) => {
    deps.authStore.revokeAllAdminSessions();
    deps.clearAdminCookie(req, res);
    res.json({ loggedOut: true, all: true });
  });

  app.get("/api/admin/secrets/status", deps.studentLimiter, deps.requireCounselorAuth, (_req, res) => {
    const encryptionConfigured = deps.WEB_DEPLOYMENT
      ? process.env.WEB_ENCRYPTION_CONFIGURED === "1"
      : /^[0-9a-f]{64}$/i.test(deps.ENCRYPTION_KEY);
    res.json({
      webDeployment: deps.WEB_DEPLOYMENT,
      installationReady: deps.WEB_SECRETS_READY,
      encryption: { configured: encryptionConfigured, mutable: deps.WEB_DEPLOYMENT && !encryptionConfigured },
      openrouter: { configured: !!deps.OPERATOR_LLM?.apiKey },
      scorecard: { configured: !!deps.SCORECARD_API_KEY },
      configReadable: !deps.WEB_CONFIG_UNREADABLE,
      configProblem: deps.WEB_CONFIG_UNREADABLE ? CONFIG_UNREADABLE_HELP : null,
    });
  });

  app.post("/api/admin/secrets/validate", deps.studentLimiter, deps.requireCounselorAuth, async (req, res) => {
    const result = await deps.validateAdminSecret(String(req.body?.kind || "").toLowerCase(), req.body?.value);
    res.status(result.valid ? 200 : 400).json(result);
  });

  app.put("/api/admin/secrets/:kind", deps.studentLimiter, deps.requireCounselorAuth, deps.requireWebConfiguration, async (req, res) => {
    const kind = String(req.params.kind || "").toLowerCase();
    if (!new Set(["encryption", "openrouter", "scorecard"]).has(kind)) {
      return res.status(404).json({ error: "Unknown secret." });
    }
    if (kind === "encryption" && process.env.WEB_ENCRYPTION_CONFIGURED === "1") {
      return res.status(409).json({ error: "The vault encryption key cannot be replaced after it is configured.", code: "encryption_immutable" });
    }
    const validation = await deps.validateAdminSecret(kind, req.body?.value);
    if (!validation.valid) {
      return res.status(validation.unavailable ? 503 : 400).json({
        error: validation.unavailable ? "The key service could not be reached. Try again." : "The secret is not valid.",
        ...validation,
      });
    }
    try {
      const current = readOrStartWebConfig(deps);
      const updated = mergeWebSecret(current, kind, req.body?.value);
      writeWebSecretConfig({ dataDir: deps.DATA_DIR, configKey: deps.WEB_CONFIG_KEY, config: updated });
      res.status(202).json({ saved: true, restarting: true });
      deps.scheduleWebConfigurationRestart();
    } catch (error) {
      console.error("[ADMIN] Failed to save encrypted website configuration:", error.code || error.message);
      res.status(500).json({ error: "The encrypted website configuration could not be saved." });
    }
  });

  app.delete("/api/admin/secrets/:kind", deps.studentLimiter, deps.requireCounselorAuth, deps.requireWebConfiguration, (req, res) => {
    const kind = String(req.params.kind || "").toLowerCase();
    if (!new Set(["openrouter", "scorecard"]).has(kind)) {
      return res.status(409).json({ error: "The vault encryption key cannot be cleared after setup." });
    }
    try {
      const current = readOrStartWebConfig(deps);
      const updated = mergeWebSecret(current, kind, "");
      writeWebSecretConfig({ dataDir: deps.DATA_DIR, configKey: deps.WEB_CONFIG_KEY, config: updated });
      res.status(202).json({ cleared: true, restarting: true });
      deps.scheduleWebConfigurationRestart();
    } catch (error) {
      console.error("[ADMIN] Failed to clear encrypted website configuration:", error.code || error.message);
      res.status(500).json({ error: "The encrypted website configuration could not be saved." });
    }
  });

  // The daily database copies (storage/db-backup.js), for the counselor to
  // take off the box: the list, and one file by its exact name.
  app.get("/api/admin/backups", deps.studentLimiter, deps.requireCounselorAuth, (_req, res) => {
    res.json({ files: listBackupFiles(path.join(deps.DATA_DIR, "backups")) });
  });

  app.get("/api/admin/backups/:file", deps.studentLimiter, deps.requireCounselorAuth, (req, res) => {
    const file = String(req.params.file || "");
    const full = path.join(deps.DATA_DIR, "backups", file);
    if (!BACKUP_FILE_RE.test(file) || !fs.existsSync(full)) return res.status(404).json({ error: "No such backup." });
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(full).pipe(res);
  });

  app.get("/api/admin/models", deps.studentLimiter, deps.requireCounselorAuth, (_req, res) => {
    res.json(deps.adminModelsPayload());
  });

  // Manual scout run from the admin page: refresh the catalog, list what is
  // new, and return the refreshed page payload.
  app.post("/api/admin/models/scout/run", deps.studentLimiter, deps.requireCounselorAuth, async (_req, res) => {
    try {
      const summary = await deps.maybeRunModelCatalogScout("manual", { force: "manual" });
      res.json({ ok: true, summary, ...deps.adminModelsPayload() });
    } catch (err) {
      console.error("[MODEL-SCOUT] manual run failed:", err.message);
      res.status(500).json({ error: "The catalog check failed.", message: String(err.message).slice(0, 200) });
    }
  });

  // Counselor review of a discovered model: dismiss it (hidden from the
  // pickers and the allowlist) or list it again.
  app.post("/api/admin/models/candidates", deps.studentLimiter, deps.requireCounselorAuth, (req, res) => {
    const modelId = String(req.body?.modelId || "").trim();
    const status = String(req.body?.status || "").trim();
    if (!modelId || !["listed", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "modelId and a status of listed or dismissed are required." });
    }
    const row = setModelCandidateStatus(deps.modelCatalogStmts, modelId, status);
    if (!row) return res.status(404).json({ error: "That model is not a discovered candidate." });
    adapterRegisterDynamicModels(dynamicAllowedModelIds(deps.modelCatalogStmts));
    res.json({ modelId, status: row.status });
  });

  app.put("/api/admin/models", deps.studentLimiter, deps.requireCounselorAuth, deps.requireWebConfiguration, (req, res) => {
    const models = req.body?.models || {};
    const allowed = new Set([...OPENROUTER_MODEL_OPTIONS.map(({ id }) => id), ...dynamicAllowedModelIds(deps.modelCatalogStmts)]);
    for (const tier of ["small", "medium", "large"]) {
      if (!allowed.has(String(models[tier] || ""))) {
        return res.status(400).json({ error: `Choose a reviewed OpenRouter model for the ${tier} tier.` });
      }
    }
    try {
      const current = readOrStartWebConfig(deps);
      const updated = mergeWebModels(current, models);
      writeWebSecretConfig({ dataDir: deps.DATA_DIR, configKey: deps.WEB_CONFIG_KEY, config: updated });
      res.status(202).json({ saved: true, restarting: true });
      deps.scheduleWebConfigurationRestart();
    } catch (error) {
      console.error("[ADMIN] Failed to save model configuration:", error.code || error.message);
      res.status(500).json({ error: "The model configuration could not be saved." });
    }
  });
}
