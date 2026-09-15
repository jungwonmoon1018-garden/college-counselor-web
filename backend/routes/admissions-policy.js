// routes/admissions-policy.js — the /api/admissions-policy routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (policyScoutStmts, requireStudentAuth, resolveTargetSchools, studentLimiter).
import { formatPolicyLine, lastRunSummary, listRecentChanges, readPolicySnapshot } from "../admissions-policy-scout.js";
import { schoolNamesCompatible } from "../cds-store.js";
import { expandCollegeAlias } from "../college-research.js";

export function registerAdmissionsPolicyRoutes(app, deps) {
  // ─── Admissions-policy scout ────────────────────────────────────────
  // Recent policy changes for the student's target schools (all tracked
  // schools when none are set), plus the current snapshot per target school.
  app.get("/api/admissions-policy/changes", deps.studentLimiter, deps.requireStudentAuth, (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
      const targets = deps.resolveTargetSchools(req.studentId);
      const all = listRecentChanges(deps.policyScoutStmts, { days, limit: 200 });
      const changes = targets.length
        ? all.filter((c) => targets.some((t) => schoolNamesCompatible(c.school, t) || schoolNamesCompatible(c.school, expandCollegeAlias(t))))
        : all.slice(0, 50);
      const schools = targets.map((name) => {
        const snapshot = readPolicySnapshot(deps.policyScoutStmts, { name: expandCollegeAlias(name) });
        return snapshot
          ? { school: snapshot.school, checkedAt: snapshot.checkedAt, changedAt: snapshot.changedAt, fields: snapshot.fields, summary: formatPolicyLine(snapshot) }
          : { school: name, checkedAt: null, fields: {}, summary: null };
      });
      res.json({ ok: true, days, lastRun: lastRunSummary(deps.policyScoutStmts), changes, schools });
    } catch (err) {
      console.error("[policy-scout] changes lookup failed:", err.message);
      res.status(500).json({ error: "Admissions policy lookup failed" });
    }
  });
}
