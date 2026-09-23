// server/schedulers.js — when the two automatic scouts run: the model catalog
// scout and the admissions policy scout, each due when its last completed run
// is a cadence old or its rule version changed, with the one-run-at-a-time
// guard for the policy scout. Moved out of server.js on 2026-09-21.
// `deps` is server.js's routeDeps object: live getters onto the bindings
// these functions read there (MODEL_SCOUT_ENABLED, SCORECARD_API_KEY,
// SCOUT_CADENCE_MS, db, factStmts, modelCatalogStmts, policyScoutStmts,
// ragStmts).
import { MODEL_SCOUT_VERSION, dynamicAllowedModelIds, lastModelCatalogRun, runModelCatalogScout } from "../scouts/model-catalog-scout.js";
import { OPENROUTER_CATALOG, refreshOpenRouterCatalog } from "../scouts/openrouter-model-refresh.js";
import { OPENROUTER_MODEL_OPTIONS } from "../llm-adapters/tier-defaults.js";
import { registerDynamicOpenRouterModels as adapterRegisterDynamicModels } from "../llm-adapters/index.js";
import { scoutRunDue } from "../scouts/scout-cadence.js";
import { baselineCollegeNames } from "./verified-data.js";
import { safeParseJSON } from "./model-calls.js";
import { extractGoalUnitIds } from "../storage/rag-engine.js";
import { extractTargetSchoolNames } from "../cds/cds-search.js";
import { detectSchoolMentions } from "../chat/chat-grounding.js";
import { resolveBaselineCollegeRow } from "./baseline-colleges.js";
import { lastAutomaticRun, policyScoutDue, policyScoutRunLimits, runPolicyScout } from "../scouts/admissions-policy-scout.js";

let deps;
export function bindSchedulers(serverDeps) { deps = serverDeps; }

export function runScheduledModelCatalogScout(trigger = "scheduled") {
  const summary = runModelCatalogScout({
    catalog: OPENROUTER_CATALOG,
    stmts: deps.modelCatalogStmts,
    knownIds: new Set(OPENROUTER_MODEL_OPTIONS.map((o) => o.id)),
    trigger,
  });
  adapterRegisterDynamicModels(dynamicAllowedModelIds(deps.modelCatalogStmts));
  console.log(`[MODEL-SCOUT] ${trigger}: ${summary.catalogCount} in catalog, ${summary.eligible} eligible, ${summary.added.length} new${summary.added.length ? ` (${summary.added.map((a) => `${a.id}→${a.tier}`).join(", ")})` : ""}${summary.pruned ? `, ${summary.pruned} removed` : ""}`);
  return summary;
}

// A newer rule set (MODEL_SCOUT_VERSION) re-reads the catalog at once so
// the picker never keeps rows the current rules would reject.
export function modelCatalogScoutSchedule(force = null) {
  const last = lastModelCatalogRun(deps.modelCatalogStmts);
  const staleVersion = last && last.scoutVersion !== MODEL_SCOUT_VERSION ? "scout_version_changed" : null;
  return scoutRunDue({ lastRun: last, cadenceMs: deps.SCOUT_CADENCE_MS, force: force || staleVersion });
}

export async function maybeRunModelCatalogScout(trigger = "scheduled", { refreshCatalog = true, force = null } = {}) {
  if (!deps.MODEL_SCOUT_ENABLED) return { skipped: "disabled" };
  const schedule = modelCatalogScoutSchedule(force);
  if (!schedule.due) return { skipped: schedule.reason, nextRunAt: schedule.nextRunAt };
  if (refreshCatalog) await refreshOpenRouterCatalog();
  return runScheduledModelCatalogScout(trigger);
}

// Which schools the policy scout watches: every student's current target
// schools, every school with a stored Common Data Set, and every school with
// cached official-page research — i.e. the schools students actually ask
// about. Names are canonicalized against the IPEDS baseline so the scout can
// use the baseline website and unit id.
export function collectPolicyScoutTargets() {
  const targets = [];
  const seenStudents = new Set();
  try {
    const rows = deps.db.prepare("SELECT student_id, goals_json FROM profile_snapshots ORDER BY datetime(created_at) DESC, rowid DESC").all();
    for (const row of rows) {
      if (seenStudents.has(row.student_id)) continue;
      seenStudents.add(row.student_id);
      const goals = safeParseJSON(row.goals_json, []);
      const fallbackRows = extractGoalUnitIds(goals)
        .map((u) => deps.db.prepare("SELECT unit_id, name FROM baseline_colleges WHERE unit_id = ?").get(u))
        .filter(Boolean);
      for (const t of extractTargetSchoolNames(goals, fallbackRows)) targets.push({ name: t.schoolName, unitId: t.unitId });
    }
  } catch (err) { console.warn("[policy-scout] student target collection failed:", err.message); }
  try { for (const r of deps.ragStmts.cds.listAll.all()) if (r.school_name) targets.push({ name: r.school_name }); } catch { /* no CDS store */ }
  try {
    for (const r of deps.db.prepare("SELECT DISTINCT display_name FROM college_research_cache").all()) if (r.display_name) targets.push({ name: r.display_name });
  } catch { /* no research cache */ }
  const knownNames = baselineCollegeNames();
  return targets.map((t) => {
    const canonical = detectSchoolMentions(t.name, { knownNames, max: 1 })[0] || t.name;
    const row = resolveBaselineCollegeRow(deps.db, { unitId: t.unitId, schoolName: canonical });
    return { name: row?.name || canonical, unitId: row?.unit_id || t.unitId || null, website: row?.website || null };
  });
}

export let policyScoutRunning = null;

export async function runScheduledPolicyScout(trigger = "scheduled", { targets = null, maxSchools = null } = {}) {
  if (policyScoutRunning) return { skipped: "already_running" };
  const list = targets || collectPolicyScoutTargets();
  if (!list.length) return { skipped: "no_targets" };
  // Every tracked school unless POLICY_SCOUT_MAX_SCHOOLS caps it; an
  // automatic sweep skips what the running scout read in the last day.
  policyScoutRunning = runPolicyScout(list, {
    stmts: deps.policyScoutStmts,
    factStmts: deps.factStmts,
    scorecardKey: deps.SCORECARD_API_KEY || null,
    ...policyScoutRunLimits(trigger, { maxSchools }),
    trigger,
  }).finally(() => { policyScoutRunning = null; });
  const summary = await policyScoutRunning;
  console.log(`[policy-scout] ${trigger}: ${summary.checked}/${summary.total} school(s) checked, ${summary.changes} change(s), ${summary.failed} failed${summary.recentlyRead ? `, ${summary.recentlyRead} read in the last day left alone` : ""}`);
  return { changed: summary.changes > 0, ...summary };
}

// Due when the last automatic sweep is a cadence old — or when a newer
// scout version (better discovery/extraction) should re-read every school
// right away rather than serve the older, weaker snapshots, or when the
// last sweep ran under older sizing rules (policyScoutDue).
export function policyScoutSchedule(force = null) {
  return policyScoutDue(lastAutomaticRun(deps.policyScoutStmts), { cadenceMs: deps.SCOUT_CADENCE_MS, force });
}

export async function maybeRunPolicyScout(trigger = "scheduled") {
  if (policyScoutRunning) return { skipped: "already_running" };
  const schedule = policyScoutSchedule();
  if (!schedule.due) return { skipped: schedule.reason, nextRunAt: schedule.nextRunAt };
  return runScheduledPolicyScout(trigger);
}
