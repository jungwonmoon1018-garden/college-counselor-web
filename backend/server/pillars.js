// server/pillars.js — mounting the knowledge-graph and Strategy Council
// routes behind the student auth boundary, with the council's budget stages.
// Moved out of server.js on 2026-09-21; called from the same place, so what
// runs when at boot is unchanged. `deps` is server.js's routeDeps object of
// live getters.
import { mountPillarRoutes } from "../routes/server-routes-pillars.js";
import { requireSelf, requireStudentAuth } from "./auth.js";
import { currentOperatorKeyConfig, reconcileStudentModelCall, releaseStudentModelCall } from "./model-calls.js";
import { OPENROUTER_TARGETS } from "../scouts/openrouter-model-refresh.js";
import { reserveBudget } from "../security/usage-budget.js";
import { validateRequiredConsents } from "../security/consent.js";

export function mountPillars(deps) {
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
      const grade = deps.authStore.getStudentGrade(studentId);
      const session = {
        studentId,
        operationId,
        stages: councilBudgetStages.map((stage) => ({ ...stage })),
      };
      try {
        for (const stage of session.stages.filter((item) => !item.deterministic)) {
          const model = OPENROUTER_TARGETS[stage.tier];
          const reservation = reserveBudget(deps.db, {
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

    mountPillarRoutes(deps.app, {
      db: deps.db,
      dataDir: deps.DATA_DIR,
      requireAuth: requireAuthBridge,
      requireSelf,
      studentLimiter: deps.studentLimiter,
      factStmts: deps.factStmts,
      evidenceStmts: deps.evidenceStmts,
      getOperatorLLM: currentOperatorKeyConfig,
      validateAIConsent: (studentId) => validateRequiredConsents(deps.piiStmts, studentId, "ai_interaction"),
      getStudentProfile: (studentId) => {
        try {
          const snap = deps.ragStmts.getLatestSnapshot.get(studentId);
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
}
