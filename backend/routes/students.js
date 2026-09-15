// routes/students.js — the /api/students routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (CHAT_EXTRACT_MAX_BYTES, SCORECARD_API_KEY, assembleProfileForGeneration, authLimiter, authStore, baselineCollegeNames, bearerToken, buildStudentCallLLM, chatGraphStmts, collectStudentRows, createSessionToken, db, deleteStudentRows, hashEmail, hashIP, maybeAutoRegenerateNarrative, piiStmts, piiVault, queueChatEvidence, ragStmts, removeStudentFiles, requireStudentAuth, safeJSON, shapeDeadline, shouldCullOverdue, stmts, studentLimiter, vectorStore).
import { normalizeEmail } from "../security-auth.js";
import { deleteAllStudentPII, hashEmail as hashPIIEmail, retrieveStudentPII, storeStudentPII } from "../pii-vault.js";
import crypto from "node:crypto";
import { getOnboardingConsentRequirements, validateRequiredConsents } from "../consent.js";
import { getBudgetStatus } from "../usage-budget.js";
import { extractGoalUnitIds, fetchAndPersistCollegeHistory, getDirectStructuredStudentData, getStudentTrends, syncStudentData } from "../rag-engine.js";
import * as chatHistory from "../chat-history.js";
import { redactProviderText, screenInput, screenOutput } from "../content-moderation.js";
import { isCrisisText } from "../policy-router.js";
import { parseAttachedFilesPreface } from "../ec-chat-evidence.js";
import * as chatGraph from "../chat-graph.js";
import { buildTranscriptParseMessages, parseTranscriptModelReply } from "../transcript-import.js";
import { ExtractionError, SUPPORTED_MIME_TYPES, extractPdfOCR, extractText, isSupportedMime } from "../file-extractors.js";
import { resolveLocale, t } from "../i18n.js";

export function registerStudentsRoutes(app, deps) {
  app.post("/api/students/register", deps.authLimiter, (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email is required.", code: "invalid_email" });
    }
    const grade = Number(req.body?.grade);
    if (![9, 10, 11, 12].includes(grade)) {
      return res.status(400).json({ error: "Grade 9-12 is required.", code: "invalid_grade" });
    }
    const emailHash = deps.hashEmail(email);
    const piiEmailHash = hashPIIEmail(email, deps.piiVault.encryptionKey);
    if (deps.piiStmts.getStudentByEmailHash?.get(piiEmailHash) || deps.authStore.hasStudentCredential(emailHash)) {
      return res.status(409).json({ error: "An account already exists for this email.", code: "account_exists" });
    }

    const studentId = crypto.randomUUID();
    try {
      const recovery = deps.authStore.createStudentCredential(studentId, emailHash, req.body?.password, { grade });
      try {
        storeStudentPII(deps.piiStmts, deps.piiVault, studentId, {
          name: req.body?.name || "",
          email,
          emailHash: piiEmailHash,
          isMinor: true,
        });
        deps.ragStmts.insertSnapshot.run(
          crypto.randomUUID(), studentId, "initial",
          null, null, "[]", "[]", "[]", "[]",
          req.body?.majorInterest || null, "[]", "registration",
        );
      } catch (storageErr) {
        deps.authStore.deleteStudentCredential(studentId);
        try { deleteAllStudentPII(deps.piiStmts, studentId); } catch {}
        throw storageErr;
      }
      const token = deps.createSessionToken(emailHash, studentId);
      const consentRequirements = getOnboardingConsentRequirements(true, req.body?.locale || "en-US");
      return res.status(201).json({ registered: true, studentId, token, recoveryCode: recovery.recoveryCode, consentRequirements });
    } catch (err) {
      if (err.code === "invalid_password" || err.code === "invalid_grade") return res.status(400).json({ error: err.message, code: err.code });
      console.error("[STUDENT] Registration error:", err.message);
      return res.status(500).json({ error: "Registration failed" });
    }
  });

  app.post("/api/students/auth", deps.authLimiter, (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const account = email ? deps.authStore.authenticateStudent(deps.hashEmail(email), req.body?.password) : null;
      if (!account) return res.status(401).json({ error: "Invalid email or password.", code: "invalid_credentials" });
      const token = deps.createSessionToken(account.emailHash, account.studentId);
      return res.json({ authenticated: true, studentId: account.studentId, token });
    } catch (err) {
      console.error("[STUDENT] Auth error:", err.message);
      return res.status(500).json({ error: "Authentication failed" });
    }
  });

  app.post("/api/students/logout", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    deps.authStore.revokeStudentSession(deps.bearerToken(req));
    res.json({ loggedOut: true });
  });

  app.post("/api/students/logout-all", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    deps.authStore.revokeAllStudentSessions(req.studentId);
    res.json({ loggedOut: true, all: true });
  });

  app.post("/api/students/recover", deps.authLimiter, (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const result = email ? deps.authStore.recoverStudent(deps.hashEmail(email), req.body?.recoveryCode, req.body?.newPassword) : null;
      if (!result) return res.status(400).json({ error: "Recovery information is invalid.", code: "invalid_recovery" });
      const token = deps.createSessionToken(result.emailHash, result.studentId);
      return res.json({ recovered: true, studentId: result.studentId, token, recoveryCode: result.recoveryCode });
    } catch (err) {
      if (err.code === "invalid_password") return res.status(400).json({ error: err.message, code: err.code });
      return res.status(500).json({ error: "Recovery failed" });
    }
  });

  app.put("/api/students/password", deps.authLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const result = deps.authStore.changeStudentPassword(req.studentId, req.body?.currentPassword, req.body?.newPassword);
      if (!result) return res.status(401).json({ error: "Current password is invalid.", code: "invalid_credentials" });
      const token = deps.createSessionToken(result.emailHash, req.studentId);
      return res.json({ changed: true, token, recoveryCode: result.recoveryCode });
    } catch (err) {
      if (err.code === "invalid_password") return res.status(400).json({ error: err.message, code: err.code });
      return res.status(500).json({ error: "Password change failed" });
    }
  });

  app.get("/api/students/budget", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    res.json(getBudgetStatus(deps.db, { studentId: req.studentId, grade: deps.authStore.getStudentGrade(req.studentId) }));
  });

  app.put("/api/students/budget", deps.studentLimiter, deps.requireStudentAuth, (_req, res) => {
    res.status(410).json({
      error: "Custom or unlimited budgets have been removed; grade-based monthly caps are enforced.",
      code: "fixed_grade_cap",
    });
  });

  app.post("/api/students/sync", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { profile, activities, goals, majorInterest, trigger } = req.body;
      if (profile?.grade != null) deps.authStore.setStudentGrade(req.studentId, profile.grade);
      const result = syncStudentData(deps.ragStmts, req.studentId, profile, activities, goals, majorInterest, trigger || "user_update");

      for (const change of result.changes || []) {
        if (change.significant) {
          deps.stmts.insertAudit.run(crypto.randomUUID(), new Date().toISOString(), `profile_${change.type}`, (req.studentEmailHash || "").slice(0, 12), change.title.slice(0, 200), deps.hashIP(req.ip));
        }
      }

      // ── Background: auto-refresh the narrative when ECs/courses/major change.
      // Fire-and-forget — never blocks/fails the sync response. The helper
      // itself gates on relevant changes, fingerprint no-ops, BYOK presence,
      // and (critically) never overwrites a student-written narrative.
      Promise.resolve()
        .then(() => deps.maybeAutoRegenerateNarrative(req.studentId, result.changes))
        .catch((err) => console.warn("[AUTO-NARRATIVE] sync hook error:", err?.message));

      // ── Background: fetch Scorecard history for goal schools ──────────────
      // Fire-and-forget — never blocks the sync response. Skips schools whose
      // cached history is still fresh (< 7 days old).
      if (deps.SCORECARD_API_KEY && Array.isArray(goals) && goals.length > 0) {
        const goalUnitIds = extractGoalUnitIds(goals);
        if (goalUnitIds.length > 0) {
          fetchAndPersistCollegeHistory(deps.db, deps.ragStmts, deps.SCORECARD_API_KEY, goalUnitIds)
            .then(r => { if (r.fetched > 0) console.log(`[SCORECARD] Background history: ${r.fetched} fetched, ${r.skipped} skipped, ${r.errors} errors`); })
            .catch(err => console.warn("[SCORECARD] Background history error:", err.message));
        }
      }

      res.json(result);
    } catch (err) {
      console.error("[SYNC] Error:", err.message);
      res.status(500).json({ error: "Sync failed" });
    }
  });

  app.get("/api/students/profile", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      const capabilities = deps.ragStmts.getLatestCapabilities.all(req.studentId);
      const milestoneCount = deps.ragStmts.getMilestones.all(req.studentId, 100).length;
      if (!snap) return res.json({ profile: null, metrics: [], milestoneCount: 0 });
      const structuredMetrics = getDirectStructuredStudentData(deps.ragStmts, req.studentId, {
        snapshot: snap,
        capabilities,
      });

      res.json({
        retrieval: "direct_db",
        profile: {
          gpa: { unweighted: snap.gpa_unweighted, weighted: snap.gpa_weighted },
          classRank: deps.safeJSON(snap.class_rank_json, null),
          courses: deps.safeJSON(snap.courses_json, []),
          apScores: deps.safeJSON(snap.ap_scores_json, []),
          testScores: deps.safeJSON(snap.test_scores_json, []),
          activities: deps.safeJSON(snap.activities_json, []),
          majorInterest: snap.major_interest,
          goals: deps.safeJSON(snap.goals_json, []),
          lastUpdated: snap.created_at,
        },
        metrics: capabilities.map(c => ({ metric: c.metric, value: c.value, percentileNational: c.percentile_national, percentileCohort: c.percentile_cohort })),
        structuredMetrics,
        milestoneCount,
      });
    } catch (err) {
      console.error("[PROFILE] Error:", err.message);
      res.status(500).json({ error: "Profile retrieval failed" });
    }
  });

  // Direct DB path for GPA / SAT / ACT / AP / activity counts. This endpoint
  // intentionally bypasses the RAG assembly layer so structured stats can be
  // consumed without any retrieval pipeline.
  app.get("/api/students/structured-metrics", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const data = getDirectStructuredStudentData(deps.ragStmts, req.studentId);
      if (!data) {
        return res.status(404).json({ error: "No profile data" });
      }
      res.json({ ok: true, ...data });
    } catch (err) {
      console.error("[PROFILE structured-metrics] Error:", err.message);
      res.status(500).json({ error: "Structured metrics retrieval failed" });
    }
  });

  app.get("/api/students/timeline", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const trends = getStudentTrends(deps.ragStmts, req.studentId);
      res.json(trends);
    } catch (err) {
      console.error("[TIMELINE] Error:", err.message);
      res.status(500).json({ error: "Timeline retrieval failed" });
    }
  });

  app.get("/api/students/milestones", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "30", 10), 100);
      const type = req.query.type || null;
      const milestones = type ? deps.ragStmts.getMilestonesByType.all(req.studentId, type, limit) : deps.ragStmts.getMilestones.all(req.studentId, limit);
      res.json({
        milestones: milestones.map(m => ({ id: m.id, type: m.type, title: m.title, data: deps.safeJSON(m.data_json, {}), academicYear: m.academic_year, date: m.created_at })),
      });
    } catch (err) {
      console.error("[MILESTONES] Error:", err.message);
      res.status(500).json({ error: "Milestones retrieval failed" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DELETE /api/students — RIGHT TO ERASURE (FERPA/GDPR/COPPA)
  // ═══════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════
  // CHAT HISTORY — per-student, multi-thread
  // ═══════════════════════════════════════════════════════════

  app.get("/api/students/threads", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
      res.json({ threads: chatHistory.listThreads(deps.ragStmts, req.studentId, limit) });
    } catch (err) {
      console.error("[CHAT] List threads error:", err.message);
      res.status(500).json({ error: "Failed to list threads" });
    }
  });

  app.post("/api/students/threads", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { title } = req.body || {};
      const result = chatHistory.createThread(deps.ragStmts, req.studentId, title);
      res.json(result);
    } catch (err) {
      console.error("[CHAT] Create thread error:", err.message);
      res.status(500).json({ error: "Failed to create thread" });
    }
  });

  app.get("/api/students/threads/:id", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const result = chatHistory.getThreadWithMessages(deps.ragStmts, req.studentId, req.params.id);
      if (!result) return res.status(404).json({ error: "Thread not found" });
      res.json(result);
    } catch (err) {
      console.error("[CHAT] Get thread error:", err.message);
      res.status(500).json({ error: "Failed to fetch thread" });
    }
  });

  // POST /api/students/threads/:id/messages — append a message turn.
  // The frontend calls this once per user turn AND once per assistant turn
  // so history survives reloads / cross-device.
  app.post("/api/students/threads/:id/messages", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { role, content, attachmentName } = req.body || {};
      const originalContent = String(content || "");
      let safeContent = originalContent;
      let crisisRelated = false;
      if (role === "user") {
        const screened = screenInput(safeContent);
        if (screened.blocked) {
          return res.status(400).json({ error: screened.reason, blocked: true });
        }
        crisisRelated = isCrisisText(safeContent);
        safeContent = crisisRelated
          ? "[Crisis-related message withheld for privacy]"
          : screened.text;
      } else if (role === "assistant") {
        safeContent = screenOutput(safeContent).text;
      }
      // Model-facing copy of a user turn (includes file-attachment context) —
      // persisted so reopening the thread replays the full context instead of
      // losing every uploaded file on reload. Screened like the display copy;
      // a blocked or crisis-flagged model copy is simply dropped.
      let safeModelContent = null;
      if (role === "user" && !crisisRelated && typeof req.body?.modelContent === "string" && req.body.modelContent) {
        const screenedModel = screenInput(req.body.modelContent);
        if (!screenedModel.blocked) safeModelContent = req.body.modelContent;
      }
      const r = chatHistory.appendMessage(
        deps.ragStmts,
        req.studentId,
        req.params.id,
        role,
        safeContent,
        String(attachmentName || "").slice(0, 240) || null,
        safeModelContent,
      );
      if (!r.ok) return res.status(400).json({ error: r.error });
      // Text-extracted uploads travel in the model-facing copy as an
      // "[Attached files — …]" block; each file is filed as EC evidence for the
      // activity it names.
      if (role === "user" && safeModelContent) {
        deps.queueChatEvidence(req.studentId, parseAttachedFilesPreface(safeModelContent), safeContent, { threadId: req.params.id, source: "persisted turn" });
      }
      if (crisisRelated) {
        chatHistory.renameThread(
          deps.ragStmts,
          req.studentId,
          req.params.id,
          chatHistory.CRISIS_SAFE_TITLE,
        );
      }
      // An assistant turn closes a question/answer pair: index it into the
      // thread graph (entities + a short advice excerpt, no model call) so
      // later turns can recall it without replaying the transcript.
      let threadGraph = null;
      if (role === "assistant") {
        try {
          const prior = chatGraph.latestUserTurn(deps.chatGraphStmts, req.params.id);
          if (prior?.content) {
            let activityNames = [];
            try {
              const profile = deps.assembleProfileForGeneration(req.studentId);
              activityNames = (profile?.activities || []).map((a) => a?.name).filter(Boolean);
            } catch { activityNames = []; }
            const indexed = chatGraph.indexTurn(deps.chatGraphStmts, {
              studentId: req.studentId,
              threadId: req.params.id,
              messageId: prior.id,
              question: prior.content,
              answer: safeContent,
              attachmentName: prior.attachmentName,
              knownSchoolNames: deps.baselineCollegeNames(),
              activityNames,
            });
            if (indexed) threadGraph = { factId: indexed.factId, entities: indexed.entities.length };
          }
        } catch (err) {
          console.warn("[CHAT] thread graph index failed:", err?.message);
        }
      }
      res.json({
        appended: true,
        redacted: safeContent !== originalContent,
        crisisSafe: crisisRelated,
        threadGraph,
      });
    } catch (err) {
      console.error("[CHAT] Append message error:", err.message);
      res.status(500).json({ error: "Failed to append message" });
    }
  });

  app.patch("/api/students/threads/:id", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { title } = req.body || {};
      const ok = chatHistory.renameThread(deps.ragStmts, req.studentId, req.params.id, title);
      if (!ok) return res.status(404).json({ error: "Thread not found" });
      res.json({ renamed: true });
    } catch (err) {
      console.error("[CHAT] Rename thread error:", err.message);
      res.status(500).json({ error: "Failed to rename thread" });
    }
  });

  // POST /api/students/threads/:id/autoname — generate a concise LLM title from
  // the thread's first user message. Crisis-safe: a message with crisis language
  // keeps the neutral "Support resources" title and is NEVER sent to a model.
  // Best-effort: no BYOK key or empty generation leaves the existing (first-line)
  // title in place. Runs on the small tier to keep it cheap.
  app.post("/api/students/threads/:id/autoname", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const bundle = chatHistory.getThreadWithMessages(deps.ragStmts, req.studentId, req.params.id);
      if (!bundle) return res.status(404).json({ error: "Thread not found" });
      const currentTitle = bundle.thread?.title || null;
      if (currentTitle === chatHistory.CRISIS_SAFE_TITLE) {
        return res.json({ title: currentTitle, crisisSafe: true, skipped: "crisis_safe" });
      }
      const firstUser = (bundle.messages || []).find((m) => m.role === "user");
      const firstText = String(firstUser?.content || "").trim();
      if (!firstText) return res.json({ title: currentTitle, skipped: "no_user_message" });

      if (isCrisisText(firstText) || firstText === "[Crisis-related message withheld for privacy]") {
        chatHistory.renameThread(deps.ragStmts, req.studentId, req.params.id, chatHistory.CRISIS_SAFE_TITLE);
        return res.json({ title: chatHistory.CRISIS_SAFE_TITLE, crisisSafe: true });
      }

      const consents = validateRequiredConsents(deps.piiStmts, req.studentId, "ai_interaction");
      if (!consents.allowed) return res.json({ title: currentTitle, skipped: "consent_required" });
      // Unique per call — the budget ledger dedupes request ids, so a constant
      // "autoname:<student>:<thread>" id let a thread be auto-named exactly once
      // and made every retry fail with a duplicate-reservation error.
      const requestId = "autoname:" + req.studentId + ":" + req.params.id + ":" + crypto.randomUUID();
      const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId, { requestIdPrefix: requestId });
      if (!modelConfig || !callLLM) return res.json({ title: currentTitle, skipped: "openrouter_not_configured" });

      const result = await callLLM({
        model: modelConfig.models?.small || undefined,
        max_tokens: 24,
        system: "You title chat conversations. Reply with ONLY a 3–6 word title in Title Case for the user's message. No quotes, no trailing punctuation, no emojis, no preamble.",
        messages: [{ role: "user", content: firstText.slice(0, 1000) }],
        requestId,
      });
      const raw = (result?.content || [])
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text).join("").trim();
      const title = raw.replace(/^["'\s]+/, "").replace(/["'\s.]+$/, "").replace(/\s+/g, " ").slice(0, 60);
      if (!title) return res.json({ title: currentTitle, skipped: "empty_generation" });
      chatHistory.renameThread(deps.ragStmts, req.studentId, req.params.id, title);
      res.json({ title });
    } catch (err) {
      console.error("[CHAT] autoname error:", err.message);
      res.status(500).json({ error: "Failed to auto-name thread" });
    }
  });

  app.delete("/api/students/threads/:id", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const hard = req.query.hard === "1";
      // A hard delete removes the thread's memory too; an archived thread
      // keeps its facts — the student can still ask what was discussed.
      if (hard) chatGraph.forgetThread(deps.chatGraphStmts, req.studentId, req.params.id);
      const ok = hard
        ? chatHistory.deleteThread(deps.ragStmts, req.studentId, req.params.id)
        : chatHistory.archiveThread(deps.ragStmts, req.studentId, req.params.id);
      if (!ok) return res.status(404).json({ error: "Thread not found" });
      res.json({ deleted: true, hard });
    } catch (err) {
      console.error("[CHAT] Delete thread error:", err.message);
      res.status(500).json({ error: "Failed to delete thread" });
    }
  });

  app.get("/api/students/threads-search", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const q = String(req.query.q || "");
      res.json({ results: chatHistory.searchMessages(deps.ragStmts, req.studentId, q) });
    } catch (err) {
      console.error("[CHAT] Search error:", err.message);
      res.status(500).json({ error: "Search failed" });
    }
  });

  app.delete("/api/students", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const sid = req.studentId;
      deps.deleteStudentRows(deps.piiVault.db, sid);
      deps.deleteStudentRows(deps.db, sid);
      deps.vectorStore.db.prepare("DELETE FROM embeddings WHERE source_id = ? AND source_type LIKE 'student%'").run(sid);
      deps.authStore.deleteStudentCredential(sid);
      await deps.removeStudentFiles(sid);
      deps.stmts.insertAudit.run(crypto.randomUUID(), new Date().toISOString(), "student_data_deleted", "", "account_erasure_completed", deps.hashIP(req.ip));
      return res.json({ deleted: true });
    } catch (err) {
      console.error("[DELETE] Error:", err.message);
      return res.status(500).json({ error: "Deletion failed" });
    }
  });

  app.get("/api/students/export", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const sid = req.studentId;
      const operational = deps.collectStudentRows(deps.db, sid, { exclude: ["student_credentials", "session_tokens"] });
      if (deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_messages'").get()) {
        operational.chat_messages = deps.db.prepare(`SELECT m.* FROM chat_messages m
          JOIN chat_threads t ON t.id = m.thread_id WHERE t.student_id = ? ORDER BY m.created_at`).all(sid);
      }
      if (deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evidence_items'").get()) {
        operational.evidence_items = deps.db.prepare("SELECT * FROM evidence_items WHERE entity_type = 'student' AND entity_id = ?").all(sid);
      }
      const piiProfile = retrieveStudentPII(deps.piiStmts, deps.piiVault, sid);
      const consents = deps.piiVault.db.prepare("SELECT * FROM consent_records WHERE student_id = ? ORDER BY created_at").all(sid);
      const documents = deps.piiVault.db.prepare(`SELECT id, doc_type, doc_classification, content_hash,
        retention_expires_at, auto_delete, created_at FROM document_vault WHERE student_id = ? ORDER BY created_at`).all(sid);
      const vectors = deps.vectorStore.db.prepare(`SELECT id, source_type, source_id, source_name, content_text,
        content_hash, metadata_json, created_at, updated_at FROM embeddings
        WHERE source_id = ? AND source_type LIKE 'student%'`).all(sid);
      const exportData = {
        exportMeta: {
          exportedAt: new Date().toISOString(),
          format: "College Counselor Student Data Export v3",
          studentId: sid,
          excludedSecurityData: ["password hashes", "recovery hashes", "session tokens", "API keys"],
        },
        profile: piiProfile,
        consentHistory: consents,
        documentMetadata: documents,
        operational,
        vectors,
      };
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="student-data-export-${new Date().toISOString().slice(0, 10)}.json"`);
      return res.json(exportData);
    } catch (err) {
      console.error("[EXPORT] Student data export error:", err.message);
      return res.status(500).json({ error: "Data export failed" });
    }
  });

  // POST /api/students/transcript-import — parse an uploaded transcript
  // (PDF / image / DOCX) into survey-shaped courses. Replaces the retired
  // transcript-text reader. Pipeline: extract text locally (pdf-parse, with an
  // OCR fallback for scanned PDFs) → redact through the provider boundary →
  // small-tier model parses courses into JSON → sanitize against the survey
  // enums. The student reviews the parsed courses in the survey UI before
  // anything is saved; nothing is written server-side here.
  app.post("/api/students/transcript-import", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const { base64, mimeType, filename } = req.body || {};
      // The chat's transcript card already holds the extracted text; a file
      // upload from the profile editor arrives as base64.
      const pastedText = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 60_000) : "";
      if (!pastedText && (typeof base64 !== "string" || !base64)) {
        return res.status(400).json({ error: "base64 or text required" });
      }
      let mime = null;
      let buf = null;
      if (!pastedText) {
        if (base64.length * 0.75 > deps.CHAT_EXTRACT_MAX_BYTES) {
          return res.status(413).json({ error: `File exceeds ${deps.CHAT_EXTRACT_MAX_BYTES} bytes` });
        }
        mime = String(mimeType || "").toLowerCase();
        if (!mime || !isSupportedMime(mime)) {
          const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
          if (ext === "docx") mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          else if (ext === "pdf") mime = "application/pdf";
          else if (ext === "txt" || ext === "md") mime = "text/plain";
        }
        if (!isSupportedMime(mime)) {
          return res.status(415).json({
            error: `Unsupported mime type: ${mime || "(unknown)"}`,
            supported: Object.keys(SUPPORTED_MIME_TYPES),
          });
        }
        try { buf = Buffer.from(base64, "base64"); }
        catch { return res.status(400).json({ error: "Invalid base64" }); }
        if (buf.length > deps.CHAT_EXTRACT_MAX_BYTES) {
          return res.status(413).json({ error: `Decoded file exceeds ${deps.CHAT_EXTRACT_MAX_BYTES} bytes` });
        }
      }

      let extraction;
      if (pastedText) extraction = { text: pastedText, kind: "text" };
      else try {
        extraction = await extractText(buf, mime);
        // Scanned transcripts have no text layer — pdf-parse returns almost
        // nothing. Fall back to per-page OCR before giving up. Kept small on
        // purpose: transcripts are 1-3 pages, and unbounded OCR (25 pages at
        // 2x scale, 60s each) can outlive the hosting proxy's request window
        // and strain a small instance's memory.
        if (extraction.kind === "pdf" && String(extraction.text || "").trim().length < 40) {
          try {
            extraction = { ...await extractPdfOCR(buf, { maxPages: 4, scale: 1.5, timeoutMs: 20_000 }), kind: "pdf" };
          } catch (ocrErr) {
            console.warn("[TRANSCRIPT-IMPORT] OCR fallback failed:", ocrErr?.code || "", ocrErr?.message);
          }
        }
      } catch (e) {
        if (!(e instanceof ExtractionError)) console.error("[TRANSCRIPT-IMPORT] parser error:", e?.message || e);
        const status = e instanceof ExtractionError && e.code === "archive_limits_exceeded"
          ? 413
          : (e instanceof ExtractionError && e.code === "content_type_mismatch" ? 415 : 422);
        return res.status(status).json({
          error: status === 413 ? "Uploaded archive exceeds safe processing limits." : "Uploaded file could not be safely processed.",
          code: e?.code || "extraction_failed",
        });
      }
      const extractedText = String(extraction?.text || "").trim();
      if (!extractedText) {
        return res.status(422).json({ error: "No readable text was found in this document.", code: "no_text" });
      }

      const consents = validateRequiredConsents(deps.piiStmts, req.studentId, "ai_interaction");
      if (!consents.allowed) {
        // `missing` lets the frontend re-grant the exact onboarding consents
        // (older signup builds never recorded cross_border_transfer) and retry.
        return res.status(403).json({
          error: "AI consent is required before transcript parsing.",
          code: "consent_required",
          missing: consents.missing,
        });
      }
      // Request ids must be unique per call: the budget ledger enforces
      // request_id uniqueness for idempotency, so a constant id (as this route
      // originally used) made the FIRST import succeed and every later one fail
      // with a duplicate-reservation error. Suffix a UUID per model call.
      const requestPrefix = "transcript-import:" + req.studentId;
      const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId, { requestIdPrefix: requestPrefix });
      if (!modelConfig || !callLLM) {
        return res.status(503).json({ error: "AI parsing is not configured on this server.", code: "openrouter_not_configured" });
      }

      // Provider boundary: strip student/school identifiers before the text
      // leaves the machine. The parser only needs course lines.
      const masked = redactProviderText(extractedText);
      const { system, user } = buildTranscriptParseMessages(masked.text);

      // Small tier first; if its reply isn't valid transcript JSON (small open
      // models are the flakiest part of this pipeline), retry once on the
      // medium tier. Provider/budget errors stop immediately — a bigger model
      // won't fix those.
      const tiers = [...new Set([modelConfig.models?.small, modelConfig.models?.medium].filter(Boolean))];
      if (tiers.length === 0) tiers.push(undefined);
      let parsed = null;
      let lastFailure = null;
      for (const model of tiers) {
        try {
          const result = await callLLM({
            model,
            max_tokens: 3000,
            temperature: 0,
            system,
            messages: [{ role: "user", content: user }],
            requestId: requestPrefix + ":" + crypto.randomUUID(),
          });
          const replyText = (result?.content || [])
            .filter((b) => b && b.type === "text" && typeof b.text === "string")
            .map((b) => b.text).join("");
          parsed = parseTranscriptModelReply(replyText);
          break;
        } catch (e) {
          lastFailure = e;
          if (e?.status || e?.provider || e?.budget) break; // provider/budget error — don't burn another call
          console.warn(`[TRANSCRIPT-IMPORT] parse attempt failed (${model || "default model"}):`, e.message);
        }
      }

      if (!parsed) {
        const e = lastFailure || {};
        if (e.status === 402 || e.code === "budget_exceeded" || e.code === "request_id_conflict") {
          return res.status(402).json({
            error: "The monthly AI budget doesn't allow this request right now. Try again later, or ask the counselor to review the budget.",
            code: e.code || "budget_exceeded",
          });
        }
        if (e.code === "auth_rejected") {
          return res.status(503).json({
            error: "The AI provider rejected the server's API key. Ask the counselor to re-check the OpenRouter key in the admin page.",
            code: "auth_rejected",
          });
        }
        if (e.status || e.provider) {
          console.error("[TRANSCRIPT-IMPORT] provider call failed:", e.code || "", e.message);
          return res.status(502).json({
            error: "The AI provider request failed. Wait a moment and try again.",
            code: e.code || "provider_error",
          });
        }
        console.warn("[TRANSCRIPT-IMPORT] model reply unparseable:", e.message);
        return res.status(422).json({ error: "Could not read course data from this document. Try a clearer copy, or add courses manually.", code: "parse_failed" });
      }

      res.json({
        gpa: parsed.gpa,
        courses: parsed.years,
        courseCount: parsed.courseCount,
        warnings: [
          ...(extraction.warning ? [String(extraction.warning)] : []),
          ...parsed.warnings,
        ],
        extractedChars: extractedText.length,
      });
    } catch (err) {
      console.error("[TRANSCRIPT-IMPORT] error:", err.message);
      res.status(500).json({ error: "Transcript import failed" });
    }
  });

  // POST /api/students/deadlines — create a personal deadline.
  // F7 from Jiyeon UX audit: the app tracks admissions rounds centrally but
  // a scared 11th grader also tracks "finish MIT essay draft", "mail paper
  // certificate to dad for re-upload", "AP BioChem registration".
  app.post("/api/students/deadlines", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { title, dueAt, category, notes, collegeIds } = req.body || {};
      if (!title || typeof title !== "string" || title.trim().length === 0) {
        return res.status(400).json({ error: "title required" });
      }
      if (!dueAt || typeof dueAt !== "string") {
        return res.status(400).json({ error: "dueAt (ISO-8601) required" });
      }
      const parsed = Date.parse(dueAt);
      if (!Number.isFinite(parsed)) {
        return res.status(400).json({ error: "dueAt must be a parseable ISO-8601 date", friendlyMessage: t("deadlines.due_at_invalid", resolveLocale(req)) });
      }
      const allowedCategories = ["personal", "admissions", "financial_aid", "test", "other"];
      const cat = allowedCategories.includes(category) ? category : "personal";
      const id = crypto.randomUUID();
      deps.ragStmts.deadlines.insert.run(
        id,
        req.studentId,
        title.trim(),
        new Date(parsed).toISOString(),
        cat,
        notes ? String(notes).slice(0, 2000) : null,
        Array.isArray(collegeIds) ? JSON.stringify(collegeIds.slice(0, 20).map(String)) : null,
        "open",
      );
      const row = deps.ragStmts.deadlines.getById.get(id, req.studentId);
      res.status(201).json({ ok: true, deadline: deps.shapeDeadline(row) });
    } catch (err) {
      console.error("[deadlines] create error:", err.message);
      res.status(500).json({ error: "Create failed" });
    }
  });

  // POST /api/students/deadlines/bulk — create several deadlines in ONE request.
  // Used when a target school is added (Early/RD/financial-aid/commit at once)
  // so we don't fire 4+ separate POSTs and trip the rate limiter (HTTP 429).
  // De-dupes against the student's existing deadline titles (case-insensitive).
  app.post("/api/students/deadlines/bulk", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : null;
      if (!items || items.length === 0) return res.status(400).json({ error: "items (non-empty array) required" });
      const allowed = ["personal", "admissions", "financial_aid", "test", "other"];
      const existing = deps.ragStmts.deadlines.listByStudent.all(req.studentId) || [];
      const existingTitles = new Set(existing.map((d) => String(d.title || "").trim().toLowerCase()));
      const created = [];
      let skipped = 0;
      for (const it of items) {
        const title = String(it?.title || "").trim();
        const due = Date.parse(it?.dueAt);
        if (!title || !Number.isFinite(due)) { skipped += 1; continue; }
        if (existingTitles.has(title.toLowerCase())) { skipped += 1; continue; }
        const cat = allowed.includes(it?.category) ? it.category : "admissions";
        const id = crypto.randomUUID();
        deps.ragStmts.deadlines.insert.run(
          id, req.studentId, title, new Date(due).toISOString(), cat,
          it?.notes ? String(it.notes).slice(0, 2000) : null,
          Array.isArray(it?.collegeIds)
            ? JSON.stringify(it.collegeIds.slice(0, 20).map(String))
            : null,
          "open",
        );
        existingTitles.add(title.toLowerCase());
        const row = deps.ragStmts.deadlines.getById.get(id, req.studentId);
        if (row) created.push(deps.shapeDeadline(row));
      }
      res.status(201).json({ ok: true, created, createdCount: created.length, skipped });
    } catch (err) {
      console.error("[deadlines] bulk create error:", err.message);
      res.status(500).json({ error: "Bulk create failed" });
    }
  });

  // GET /api/students/deadlines — list all deadlines for the current student.
  app.get("/api/students/deadlines", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const locale = resolveLocale(req);
      const rows = deps.ragStmts.deadlines.listByStudent.all(req.studentId) || [];
      const now = Date.now();
      const shaped = rows.map((r) => deps.shapeDeadline(r, now));
      const upcoming = shaped.filter((d) => d.status === "open" && d.daysUntil >= 0);
      const overdue = shaped.filter((d) => d.status === "open" && d.daysUntil < 0);
      const done = shaped.filter((d) => d.status === "done");

      // Before Aug 1, hide overdue deadlines from the surface and don't nag about
      // them; they re-show automatically once the new cycle starts (Aug 1+).
      const cullOverdue = deps.shouldCullOverdue(now);
      const visible = cullOverdue
        ? shaped.filter((d) => !(d.status === "open" && d.daysUntil < 0))
        : shaped;
      const overdueCount = cullOverdue ? 0 : overdue.length;

      let friendlyMessage;
      if (overdueCount > 0) {
        friendlyMessage = t(
          overdueCount === 1 ? "deadlines.overdue_one" : "deadlines.overdue_many",
          locale,
          { count: overdueCount },
        );
      } else if (upcoming.length === 0) {
        friendlyMessage = t("deadlines.no_upcoming", locale);
      } else {
        const next = upcoming[0];
        friendlyMessage = t(
          next?.daysUntil === 1 ? "deadlines.upcoming_next_one" : "deadlines.upcoming_next_many",
          locale,
          { count: upcoming.length, title: next?.title, days: next?.daysUntil },
        );
      }
      res.json({
        ok: true,
        count: visible.length,
        upcomingCount: upcoming.length,
        overdueCount,
        doneCount: done.length,
        deadlines: visible,
        locale,
        friendlyMessage,
        overdueCulled: cullOverdue ? overdue.length : 0,
      });
    } catch (err) {
      console.error("[deadlines] list error:", err.message);
      res.status(500).json({ error: "List failed" });
    }
  });

  // PATCH /api/students/deadlines/:id — update status or fields.
  app.patch("/api/students/deadlines/:id", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { id } = req.params;
      const existing = deps.ragStmts.deadlines.getById.get(id, req.studentId);
      if (!existing) return res.status(404).json({ error: "deadline not found" });
      const { title, dueAt, category, notes, collegeIds, status } = req.body || {};
      const locale = resolveLocale(req);
      // Status-only convenience path.
      if (status && !title && !dueAt && !category && notes === undefined && !collegeIds) {
        if (!["open", "done", "snoozed"].includes(status)) {
          return res.status(400).json({ error: "status must be open|done|snoozed", friendlyMessage: t("deadlines.status_invalid", locale) });
        }
        deps.ragStmts.deadlines.updateStatus.run(status, id, req.studentId);
      } else {
        if (dueAt && !Number.isFinite(Date.parse(dueAt))) {
          return res.status(400).json({ error: "dueAt must be a parseable ISO-8601 date", friendlyMessage: t("deadlines.due_at_invalid", locale) });
        }
        if (status && !["open", "done", "snoozed"].includes(status)) {
          return res.status(400).json({ error: "status must be open|done|snoozed", friendlyMessage: t("deadlines.status_invalid", locale) });
        }
        deps.ragStmts.deadlines.updateFields.run(
          title ? title.trim() : null,
          dueAt ? new Date(Date.parse(dueAt)).toISOString() : null,
          category || null,
          notes !== undefined ? (notes ? String(notes).slice(0, 2000) : null) : null,
          Array.isArray(collegeIds) ? JSON.stringify(collegeIds.slice(0, 20).map(String)) : null,
          id,
          req.studentId,
        );
        if (status) deps.ragStmts.deadlines.updateStatus.run(status, id, req.studentId);
      }
      const updated = deps.ragStmts.deadlines.getById.get(id, req.studentId);
      res.json({ ok: true, deadline: deps.shapeDeadline(updated) });
    } catch (err) {
      console.error("[deadlines] update error:", err.message);
      res.status(500).json({ error: "Update failed" });
    }
  });

  // DELETE /api/students/deadlines/by-school — cascade: remove every deadline
  // tied to a university when it's removed from the student's college list.
  // Matches by school name in the title OR the school's unitId in college_ids_json.
  // MUST be registered before the /:id route so "by-school" isn't parsed as an id.
  app.delete("/api/students/deadlines/by-school", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const schoolName = String(req.body?.schoolName || "").trim();
      const unitId = req.body?.unitId != null ? String(req.body.unitId).trim() : null;
      if (schoolName.length < 3 && !unitId) {
        return res.status(400).json({ error: "schoolName (3+ chars) or unitId required" });
      }
      // A <3-char name is too broad to title-match safely; fall back to unitId-only.
      const escapedName = schoolName.toLowerCase().replace(/[!%_]/g, "!$&");
      const titleLike = schoolName.length >= 3 ? `%${escapedName}%` : "__no_deadline_match__";
      const info = deps.ragStmts.deadlines.deleteBySchool.run(req.studentId, titleLike, unitId, unitId);
      res.json({ deleted: info.changes | 0 });
    } catch (err) {
      console.error("[deadlines] delete-by-school error:", err.message);
      res.status(500).json({ error: "Delete failed" });
    }
  });

  // DELETE /api/students/deadlines/:id — remove a deadline.
  app.delete("/api/students/deadlines/:id", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { id } = req.params;
      const existing = deps.ragStmts.deadlines.getById.get(id, req.studentId);
      if (!existing) return res.status(404).json({ error: "deadline not found" });
      deps.ragStmts.deadlines.delete.run(id, req.studentId);
      res.status(204).end();
    } catch (err) {
      console.error("[deadlines] delete error:", err.message);
      res.status(500).json({ error: "Delete failed" });
    }
  });
}
