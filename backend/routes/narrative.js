// routes/narrative.js — the /api/narrative routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (assembleProfileForGeneration, buildStudentCallLLM, generateNarrativeDraftText, getSchoolPriorities, ragStmts, requireStudentAuth, resolveTargetSchools, respondLLMError, schoolPrioritiesPromptBlock, studentLimiter).
import { resolveLocale, t } from "../i18n.js";
import { getActiveNarrative } from "../narrative-store.js";

export function registerNarrativeRoutes(app, deps) {
  // GET /api/narrative/drift — detect stale EC vectors after a narrative edit.
  // Jiyeon UX audit F10: when the student rewrites their narrative (e.g. she
  // pivots from "pre-med" to "computational biology"), every EC strength
  // vector that was computed against the old narrative is now stale — the
  // narrative_fit score might be wildly off. This endpoint surfaces which
  // ECs need recompute so the UI can show a "N activities need to be rescored"
  // banner and offer a one-click recompute.
  app.get("/api/narrative/drift", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const locale = resolveLocale(req);
      const active = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      if (!active) {
        return res.json({
          ok: true,
          // The banner keys its display off `status`: it stays hidden on
          // "all_fresh" and offers the write-story path on
          // "no_active_narrative". Without the field it rendered the
          // "you're up to date" message as a warning on every visit.
          status: "no_active_narrative",
          hasActive: false,
          activeNarrativeId: null,
          activeHash: null,
          staleCount: 0,
          freshCount: 0,
          stale: [],
          fresh: [],
          locale,
          friendlyMessage: t("drift.no_active_narrative", locale),
        });
      }
      const rows = deps.ragStmts.strength?.getByStudent?.all(req.studentId) || [];
      const stale = [];
      const fresh = [];
      for (const row of rows) {
        const entry = {
          ecName: row.ec_name,
          narrativeVersionId: row.narrative_version_id || null,
          narrativeFit: row.narrative_fit,
          updatedAt: row.updated_at,
        };
        if (!row.narrative_version_id || row.narrative_version_id !== active.id) {
          stale.push({ ...entry, reason: !row.narrative_version_id ? "never_tied_to_narrative" : "narrative_changed" });
        } else {
          fresh.push(entry);
        }
      }
      const staleCount = stale.length;
      const friendlyMessage =
        staleCount === 0
          ? t("drift.all_fresh", locale)
          : staleCount === 1
          ? t("drift.one_stale", locale)
          : t("drift.many_stale", locale, { count: staleCount });
      res.json({
        ok: true,
        status: staleCount === 0 ? "all_fresh" : staleCount === 1 ? "one_stale" : "many_stale",
        hasActive: true,
        activeNarrativeId: active.id,
        activeHash: active.hash,
        activeUpdatedAt: active.createdAt || null,
        totalEC: rows.length,
        staleCount,
        freshCount: fresh.length,
        stale,
        fresh,
        recomputeUrl: staleCount > 0 ? `/api/ec/strength/recompute` : null,
        locale,
        friendlyMessage,
      });
    } catch (err) {
      console.error("[narrative drift] error:", err.message);
      res.status(500).json({ error: "Drift detection failed" });
    }
  });

  // POST /api/narrative/draft — generate a DRAFT 100-1500 char self-presentation
  // from the student's profile. NOT an essay (SKILL.md permits drafting short
  // self-presentation statements). NOT saved — the student edits and saves via
  // POST /api/ec/narrative.
  app.post("/api/narrative/draft", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const locale = resolveLocale(req);
      const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId);
      if (!modelConfig) return res.status(503).json({ error: "The administrator must configure OpenRouter first." });
      const profile = deps.assembleProfileForGeneration(req.studentId);
      if (!profile) return res.status(404).json({ error: "No profile data. Complete your profile first." });
      const existing = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
      const targetSchools = deps.resolveTargetSchools(req.studentId, req.body?.targetSchools);
      const priorities = await deps.getSchoolPriorities(targetSchools);
      const schoolBlock = deps.schoolPrioritiesPromptBlock(priorities);
      const draft = await deps.generateNarrativeDraftText({ profile, existing, callLLM, modelConfig, schoolBlock });
      res.json({ ok: true, draft, chars: draft.length, targetSchools, locale });
    } catch (err) {
      if (Number.isInteger(err?.status) || err?.code) return deps.respondLLMError(res, err, "narrative draft");
      console.error("[narrative draft] error:", err.message);
      res.status(500).json({ error: "Narrative draft generation failed" });
    }
  });
}
