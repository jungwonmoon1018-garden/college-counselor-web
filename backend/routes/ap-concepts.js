// routes/ap-concepts.js — the /api/ap-concepts routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (ragStmts, requireStudentAuth, safeParse, studentLimiter).
import { AP_CONCEPT_CATALOG, getAllAPSubjects, getConceptsForSubject } from "../ap-concept-catalog.js";
import { classifyInputToAPConcepts, overrideStudentConcept, processStudentInputForConcepts, recomputeAllSubjectVectors, recomputeSubjectVector } from "../ap-concept-vectorizer.js";

export function registerApConceptsRoutes(app, deps) {
  // ═════════════════════════════════════════════════════════════════════
  // AP CONCEPT COMPONENTS
  // ─────────────────────────────────────────────────────────────────────
  // Each AP subject vector is the weighted sum of its concept components.
  // Concept rows are LAZY: created only when the student's own evidence
  // (prompt or file) references the subject. Updates propagate immediately.
  // ═════════════════════════════════════════════════════════════════════

  // GET: full catalog of AP subjects and their concept definitions.
  // Safe to call without auth — this is public reference data.
  app.get("/api/ap-concepts/catalog", deps.studentLimiter, (req, res) => {
    try {
      const { subject } = req.query;
      if (subject) {
        const concepts = getConceptsForSubject(subject);
        if (!concepts.length) return res.status(404).json({ error: "Unknown subject" });
        const weightSum = concepts.reduce((s, c) => s + (Number(c.weight) || 0), 0);
        return res.json({ ok: true, subject, concepts, weightSum: Math.round(weightSum * 1000) / 1000 });
      }
      const allSubjects = getAllAPSubjects().map((sid) => {
        const concepts = getConceptsForSubject(sid);
        return {
          subject_id: sid,
          concept_count: concepts.length,
          weight_sum: Math.round(concepts.reduce((s, c) => s + (Number(c.weight) || 0), 0) * 1000) / 1000,
        };
      });
      res.json({ ok: true, subjects: allSubjects });
    } catch (err) {
      console.error("[AP-CONCEPTS] catalog error:", err.message);
      res.status(500).json({ error: "Catalog retrieval failed" });
    }
  });

  // GET: student's current AP subject vectors + concept components.
  // Returns only subjects the student has evidence for (lazy init contract).
  app.get("/api/ap-concepts/vectors", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const subjectVectors = deps.ragStmts.apConcepts.getAllSubjectVectors.all(req.studentId) || [];
      const studentConcepts = deps.ragStmts.apConcepts.getAllStudentConcepts.all(req.studentId) || [];

      // Group concepts by subject for the response.
      const conceptsBySubject = new Map();
      for (const row of studentConcepts) {
        if (!conceptsBySubject.has(row.subject_id)) conceptsBySubject.set(row.subject_id, []);
        conceptsBySubject.get(row.subject_id).push({
          concept_id: row.concept_id,
          mastery: row.mastery,
          last_signal: row.last_signal,
          evidence_count: row.evidence_count,
          is_overridden: Boolean(row.is_overridden),
          override_mastery: row.override_mastery,
          first_seen_at: row.first_seen_at,
          updated_at: row.updated_at,
        });
      }

      res.json({
        ok: true,
        studentId: req.studentId,
        subjects: subjectVectors.map((v) => ({
          subject_id: v.subject_id,
          subject_vector: v.subject_vector,
          weighted_total: v.weighted_total,
          concept_count: v.concept_count,
          components: deps.safeParse(v.components_json) || [],
          computed_at: v.computed_at,
          concepts: conceptsBySubject.get(v.subject_id) || [],
        })),
        count: subjectVectors.length,
      });
    } catch (err) {
      console.error("[AP-CONCEPTS] vectors error:", err.message);
      res.status(500).json({ error: "Vector retrieval failed" });
    }
  });

  // GET: per-subject detail (components + per-concept evidence).
  app.get("/api/ap-concepts/vectors/:subject", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const subjectId = req.params.subject;
      const catalog = getConceptsForSubject(subjectId);
      if (!catalog.length) return res.status(404).json({ error: "Unknown subject" });

      const vec = deps.ragStmts.apConcepts.getSubjectVector.get(req.studentId, subjectId);
      const conceptRows = deps.ragStmts.apConcepts.getStudentConceptsForSubject.all(req.studentId, subjectId) || [];

      res.json({
        ok: true,
        studentId: req.studentId,
        subject_id: subjectId,
        subject_vector: vec?.subject_vector ?? null,
        weighted_total: vec?.weighted_total ?? null,
        components: deps.safeParse(vec?.components_json) || [],
        reasoning: deps.safeParse(vec?.reasoning_json) || [],
        concepts: catalog.map((c) => {
          const row = conceptRows.find((r) => r.concept_id === c.concept_id);
          return {
            concept_id: c.concept_id,
            concept_name: c.concept_name,
            description: c.description,
            weight: c.weight,
            mastery: row?.mastery ?? null,          // null = not yet seen (lazy)
            evidence_count: row?.evidence_count ?? 0,
            is_overridden: Boolean(row?.is_overridden),
            override_mastery: row?.override_mastery ?? null,
            evidence: deps.safeParse(row?.evidence_json) || [],
            first_seen_at: row?.first_seen_at ?? null,
            updated_at: row?.updated_at ?? null,
          };
        }),
        computed_at: vec?.computed_at ?? null,
      });
    } catch (err) {
      console.error("[AP-CONCEPTS] subject-detail error:", err.message);
      res.status(500).json({ error: "Subject detail retrieval failed" });
    }
  });

  // POST: classify a piece of student text/file content and update concepts.
  // Body: { text: string, hintSubject?: string, source?: "prompt"|"file"|... }
  app.post("/api/ap-concepts/input", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { text, hintSubject, source } = req.body || {};
      if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "text (non-empty string) is required" });
      }
      if (text.length > 50_000) {
        return res.status(413).json({ error: "text too large (max 50k chars)" });
      }
      const result = processStudentInputForConcepts(
        deps.ragStmts.apConcepts, req.studentId, text,
        { hintSubject, source: source || "input" }
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[AP-CONCEPTS] input error:", err.message);
      res.status(500).json({ error: "Concept classification failed" });
    }
  });

  // POST: dry-run classification (no DB writes) — useful for frontend preview.
  app.post("/api/ap-concepts/classify", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { text, hintSubject } = req.body || {};
      if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "text (non-empty string) is required" });
      }
      const classifications = classifyInputToAPConcepts(text, { hintSubject });
      res.json({ ok: true, classifications });
    } catch (err) {
      console.error("[AP-CONCEPTS] classify error:", err.message);
      res.status(500).json({ error: "Classification failed" });
    }
  });

  // POST: student overrides a single concept mastery.
  // Body: { subject_id, concept_id, mastery (0-1) }
  app.post("/api/ap-concepts/override", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { subject_id, concept_id, mastery } = req.body || {};
      if (!subject_id || !concept_id) {
        return res.status(400).json({ error: "subject_id and concept_id are required" });
      }
      if (!AP_CONCEPT_CATALOG[subject_id]) {
        return res.status(400).json({ error: "Unknown subject_id" });
      }
      const inCatalog = getConceptsForSubject(subject_id).some((c) => c.concept_id === concept_id);
      if (!inCatalog) return res.status(400).json({ error: "Unknown concept_id for subject" });

      const m = Number(mastery);
      if (!Number.isFinite(m) || m < 0 || m > 1) {
        return res.status(400).json({ error: "mastery must be a number in [0, 1]" });
      }
      const result = overrideStudentConcept(
        deps.ragStmts.apConcepts,
        { studentId: req.studentId, subjectId: subject_id, conceptId: concept_id, mastery: m }
      );
      res.json({ ok: true, override: result });
    } catch (err) {
      console.error("[AP-CONCEPTS] override error:", err.message);
      res.status(500).json({ error: "Override failed" });
    }
  });

  // POST: clear a previous override (re-enables automatic recomputation).
  app.post("/api/ap-concepts/override/clear", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const { subject_id, concept_id } = req.body || {};
      if (!subject_id || !concept_id) {
        return res.status(400).json({ error: "subject_id and concept_id are required" });
      }
      deps.ragStmts.apConcepts.clearStudentConceptOverride.run(req.studentId, subject_id, concept_id);
      const vec = recomputeSubjectVector(deps.ragStmts.apConcepts, req.studentId, subject_id);
      res.json({ ok: true, subject_vector: vec });
    } catch (err) {
      console.error("[AP-CONCEPTS] override-clear error:", err.message);
      res.status(500).json({ error: "Override clear failed" });
    }
  });

  // POST: force full recomputation of every cached subject vector.
  app.post("/api/ap-concepts/recompute", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const vectors = recomputeAllSubjectVectors(deps.ragStmts.apConcepts, req.studentId);
      res.json({ ok: true, count: vectors.length, vectors });
    } catch (err) {
      console.error("[AP-CONCEPTS] recompute error:", err.message);
      res.status(500).json({ error: "Recompute failed" });
    }
  });
}
