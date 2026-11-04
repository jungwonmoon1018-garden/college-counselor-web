// routes/calendar.js — the /api/calendar routes, moved out of server.js on
// 2026-09-16 so the server file holds setup and helpers only. `deps` is
// the server's routeDeps object: live getters onto the module bindings
// these handlers use (SCORECARD_API_KEY, buildAdmissionsCalendar, buildStudentCallLLM, collegeResearchStmts, piiStmts, policyScoutStmts, ragStmts, requireStudentAuth, resolveTargetSchools, scoutSchoolOnDemand, studentLimiter).
import { resolveLocale } from "../shared/i18n.js";
import { validateRequiredConsents } from "../security/consent.js";
import { readCachedDeadlines, researchCollegeDeadlines } from "../colleges/college-research.js";
import { readPolicySnapshot, snapshotAsDeadlineRecord, snapshotIsCurrent } from "../scouts/admissions-policy-scout.js";
import crypto from "node:crypto";
import { cdsDeadlinesForCycle, resolveStoredCdsRecord } from "../cds/cds-store.js";
import { applicationCycleStartYear, cycleLabel, planningCycleStartYear, typicalDeadlineDates } from "../shared/admissions-cycle.js";

export function registerCalendarRoutes(app, deps) {
  // POST /api/calendar/context — date awareness for the consultant agent.
  // Returns today plus a deterministic current-cycle calendar (phase, typical
  // deadlines, and approximate HS breaks). Per-school dates come from the
  // official-source deadline cache when available. Live research of a school's
  // own admissions pages runs only when the caller asks for it (research: true,
  // at most 3 schools), the student holds the AI consents, and OpenRouter is
  // configured — otherwise schools fall back to the labeled typical dates.
  app.post("/api/calendar/context", deps.studentLimiter, deps.requireStudentAuth, async (req, res) => {
    try {
      const locale = resolveLocale(req);
      const now = new Date();
      const calendar = deps.buildAdmissionsCalendar(now);
      // The cycle this student applies in, from their class year: a junior's
      // is next fall's, not the senior cycle the calendar outlines. The
      // client dates a target school's reminders for it; every school gave
      // a sophomore this year's Early date, already past on the day it was
      // created (shared/admissions-cycle.js).
      let classOf = null;
      try { classOf = deps.authStore?.getStudentClassOf?.(req.studentId) ?? null; } catch { classOf = null; }
      const ownStart = applicationCycleStartYear(classOf, now);
      const studentCycle = {
        cycle: cycleLabel(ownStart),
        startYear: ownStart,
        entryYear: ownStart + 1,
        classOf,
        // Later than the planning cycle: a school's dates for this cycle are
        // not published yet, so the client carries them forward as approximate.
        projected: ownStart > planningCycleStartYear(now),
        typicalISO: typicalDeadlineDates(ownStart),
      };
      const cdsStart = Math.min(ownStart, planningCycleStartYear(now));
      const targetSchools = deps.resolveTargetSchools(req.studentId, req.body?.targetSchools);

      const wantsResearch = req.body?.research === true && targetSchools.length <= 3;
      let researcher = null;
      if (wantsResearch) {
        const consents = validateRequiredConsents(deps.piiStmts, req.studentId, "ai_interaction");
        if (consents.allowed) {
          const { modelConfig, callLLM } = deps.buildStudentCallLLM(req.studentId, { requestIdPrefix: "deadline-research:" + req.studentId });
          if (modelConfig && callLLM) {
            researcher = { callLLM, model: modelConfig.models?.medium || undefined };
          }
        }
      }

      const schools = [];
      for (const school of targetSchools) {
        let record = readCachedDeadlines(deps.collegeResearchStmts, school);
        let stale = false;
        if (!record) {
          try {
            const snapshot = readPolicySnapshot(deps.policyScoutStmts, { name: school });
            record = snapshot ? snapshotAsDeadlineRecord(snapshot) : null;
            stale = Boolean(snapshot) && !snapshotIsCurrent(snapshot);
          } catch { record = null; }
        }
        // No cached record and no scout snapshot — or a snapshot from an older
        // scout version or of another cycle (snapshotIsCurrent): read the
        // school's own admissions pages now
        // (deterministic, bounded, no model), the same on-demand read the
        // chat's deadline lookup uses. Johns Hopkins was getting the generic
        // January 1 / February 1 fallbacks in its reminders although its pages
        // state January 2 and January 15, because the scout only tracks a
        // fixed list and the model research is optional. A stale snapshot
        // stands if the read fails.
        if (!record || stale) {
          try {
            const status = await deps.scoutSchoolOnDemand(school);
            if (status === "ok") {
              const snapshot = readPolicySnapshot(deps.policyScoutStmts, { name: school });
              record = (snapshot ? snapshotAsDeadlineRecord(snapshot) : null) || record;
            }
          } catch (err) {
            console.warn(`[calendar context] on-demand read failed for ${school}:`, err?.message);
          }
        }
        if (!record && researcher) {
          try {
            record = await researchCollegeDeadlines({
              collegeName: school,
              scorecardKey: deps.SCORECARD_API_KEY || null,
              callLLM: (args) => researcher.callLLM({ ...args, requestId: "deadline-research:" + req.studentId + ":" + crypto.randomUUID() }),
              model: researcher.model,
              stmts: deps.collegeResearchStmts,
            });
          } catch (err) {
            console.warn(`[calendar context] deadline research failed for ${school}:`, err?.code || err?.message);
          }
        }
        // Last institutional fallback before the typical-cycle table: the
        // closing dates the school reported in its Common Data Set, rolled
        // forward to this cycle. Labeled as such — the client titles these
        // "(from Common Data Set — confirm)". A senior from Feb 1 to Jul 31
        // is still in the closing cycle, a year before the planning one:
        // placed in the planning cycle, her March 1 regular deadline came
        // back as next year's and the client dropped it as not hers. The
        // dates go in the earlier of her cycle and the planning cycle, so
        // anyone later still gets the planning cycle's, carried forward.
        let cdsDates = null;
        if (!record) {
          try {
            const stored = resolveStoredCdsRecord(deps.ragStmts, { schoolName: school });
            cdsDates = stored ? cdsDeadlinesForCycle(stored, now, { startYear: cdsStart }) : null;
          } catch { cdsDates = null; }
        }
        schools.push(record
          ? { school, deadlines: record.deadlines, labels: record.labels || null, source: record.sourceUrl, cycle: record.cycle, extractedAt: record.extractedAt }
          : cdsDates
            ? { school, deadlines: cdsDates.deadlines, source: "cds", sourceLabel: cdsDates.label, sourceUrl: cdsDates.sourceUrl, cycle: cdsDates.cycle }
            : { school, deadlines: null, source: "typical" });
      }
      const deadlinesSource = schools.some((s) => s.deadlines && s.source !== "cds")
        ? "official_pages"
        : schools.some((s) => s.source === "cds")
          ? "cds"
          : (targetSchools.length ? "typical" : "none");

      res.json({ ok: true, today: calendar.today, calendar, studentCycle, schools, deadlinesSource, targetSchools, locale });
    } catch (err) {
      console.error("[calendar context] error:", err.message);
      res.status(500).json({ error: "Calendar context failed" });
    }
  });
}
