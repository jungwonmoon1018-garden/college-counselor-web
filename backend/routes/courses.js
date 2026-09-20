// routes/courses.js — the /api/courses routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (COURSE_CONCEPT_GAP_THRESHOLD, getSchoolPriorities, ragStmts, requireStudentAuth, resolveTargetSchools, safeParseJSON, studentLimiter).
import { resolveLocale } from "../shared/i18n.js";
import { getActiveNarrative } from "../activities/narrative-store.js";
import { buildStudentModel } from "../colleges/positioning-engine.js";
import { apExamScoresBySubject, conceptSignalFor, coursesWithApExams, diffCoursesAgainstSequence } from "../academics/course-sequence-catalog.js";

export function registerCoursesRoutes(app, deps) {
  app.get("/api/courses/recommendations", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const locale = resolveLocale(req);
      const snap = deps.ragStmts.getLatestSnapshot.get(req.studentId);
      if (!snap) return res.status(404).json({ error: "No profile data", locale });

      const requestedMajor = (typeof req.query.major === "string" && req.query.major.trim())
        ? req.query.major.trim()
        : (snap.major_interest || null);
      const strengthRows = deps.ragStmts.strength.getByStudent.all(req.studentId) || [];
      const narrative = getActiveNarrative(deps.ragStmts.narrative, req.studentId);
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

      const bucket = studentModel.majorBucket;
      // AP exam results count as AP courses taken (course-sequence-catalog.js).
      const diff = diffCoursesAgainstSequence(coursesWithApExams(studentModel.courses, deps.safeParseJSON(snap.ap_scores_json, [])), bucket);

      // Pull current AP subject vectors so we can attach concept-level mastery
      // / gap signals to each recommended course. A "thin" subject vector on a
      // course the major leans on is exactly the early-warning a multi-year
      // counseling package would surface.
      let subjectVectorById = new Map();
      try {
        const subjectVectors = deps.ragStmts.apConcepts?.getAllSubjectVectors?.all(req.studentId) || [];
        subjectVectorById = new Map(subjectVectors.map((v) => [v.subject_id, v]));
      } catch (err) {
        console.warn("[courses/recommendations] AP vectors fetch failed:", err.message);
      }

      // The AP exam score, when the student has one for the subject,
      // outranks the chat-derived concept vector (course-sequence-catalog.js
      // conceptSignalFor).
      const examBySubject = apExamScoresBySubject(deps.safeParseJSON(snap.ap_scores_json, []));
      const attachConceptSignal = (ref) => {
        if (!ref.apSubject) return { ...ref };
        const vec = subjectVectorById.get(ref.apSubject);
        const conceptSignal = conceptSignalFor({
          apSubject: ref.apSubject,
          subjectVector: vec && vec.subject_vector != null ? Number(vec.subject_vector) : null,
          examScore: examBySubject.has(ref.apSubject) ? examBySubject.get(ref.apSubject) : null,
          threshold: deps.COURSE_CONCEPT_GAP_THRESHOLD,
        });
        return { ...ref, conceptSignal };
      };

      // ── Three trust lanes ──
      // VERIFIED: target schools' real, cited academic priorities from their
      // Common Data Set — rigor of secondary record + test policy. These are
      // the closest thing to "stated course expectations" we can cite, never
      // invented. Tailors the recommender to the specific schools the student
      // wants (request override → saved goals).
      const targetSchools = deps.resolveTargetSchools(req.studentId, (() => {
        const q = req.query.targetSchools;
        if (!q) return null;
        return Array.isArray(q) ? q : String(q).split(",").map(s => s.trim()).filter(Boolean);
      })());
      const priorities = await deps.getSchoolPriorities(targetSchools);
      const verified = priorities.filter(p => p.hasData).map((p) => {
        const rigor = p.c7?.rigor ? String(p.c7.rigor).replace(/_/g, " ") : null;
        return {
          school: p.school,
          statement: rigor
            ? `${p.school} rates rigor of secondary record "${rigor}" in its Common Data Set${p.admitRate != null ? ` (admit ~${p.admitRate}%)` : ""} — a demanding, coherent course load matters here.`
            : `${p.school} Common Data Set on file${p.admitRate != null ? ` (admit ~${p.admitRate}%)` : ""}.`,
          source: p.sourceUrl ? { url: p.sourceUrl } : null,
        };
      });
      // INFERENCE: what the major's structure implies — the reference ladder
      // and the student's standing against it. Labeled as inference, not fact.
      const inference = {
        label: "Inferred from the typical structure of this major — not a school requirement.",
        bucket,
        majorLabel: diff.label,
        isGenericLadder: diff.isGeneric,
        have: diff.have.map(attachConceptSignal),
        missing: diff.missing.map(attachConceptSignal),
        majorRelevantCourseCount: studentModel.relevantCourses.length,
        majorRelevantGpa: studentModel.majorRelevantGpa,
      };
      // COACHING: concrete, non-binding "you might consider" next steps.
      const coaching = {
        label: "Non-binding coaching suggestions — discuss with your counselor before changing your schedule.",
        next: diff.next.map((ref) => {
          const withSignal = attachConceptSignal(ref);
          const gap = withSignal.conceptSignal?.status === "developing";
          return {
            ...withSignal,
            suggestion: gap
              ? `You might consider ${ref.name}. ${ref.why} Your current work in this area reads as still developing, so this would both fill a course gap and deepen mastery.`
              : `You might consider ${ref.name}. ${ref.why}`,
          };
        }),
        wellbeingNote: "Add depth before breadth — a coherent sequence beats a longer list of unrelated courses.",
      };

      res.json({
        ok: true,
        locale,
        major: requestedMajor,
        bucket,
        targetSchools,
        lanes: { verified, inference, coaching },
      });
    } catch (err) {
      console.error("[courses/recommendations] error:", err.message);
      res.status(500).json({ error: "Course recommendation failed" });
    }
  });
}
