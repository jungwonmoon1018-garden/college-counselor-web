// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// RAG ENGINE ??Retrieval-Augmented Generation (redesigned)
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// REDESIGNED: Small-context retrieval, no PII in context, rules-first.
//
// Changes from original:
//   - Student PII lives in pii-vault.js, NOT here
//   - Provider credentials are never stored in student records
//   - Percentile computation delegates to rules-engine.js
//   - Context assembly returns structured summaries (100-200 tokens)
//     instead of raw data dumps
//   - Only latest snapshot by default (history only when trends requested)
//   - Student identity replaced with [STUDENT] placeholder in context
//   - Baseline tables remain here (operational data, not PII)
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
import crypto from "node:crypto";
import { computePercentile, computeAPRigorIndex } from "./rules-engine.js";
import { normalizeClassRank } from "./test-catalog.js";
import { getCollegeHistory, summarizeCollegeHistory } from "./college-scorecard.js";
import { recomputeStudentDirectionality } from "./ec-vectorizer.js";
import { recomputeStudentECStrengthVectors, buildDefaultLLMClient, toPublicShape as toStrengthPublicShape } from "./ec-strength-vectorizer.js";
import { getActiveNarrative } from "./narrative-store.js";
export { initRAGTables, seedBaselines, hydrateBaselineWebsites, prepareRAGStatements } from "./rag-schema.js";


// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// COLLEGE SCORECARD ??historical data helpers
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
/**
 * For each unitId in the list, fetch ~10 years of Scorecard history and
 * persist it in `scorecard_history` + `scorecard_cache`. Schools whose
 * cached data is still fresh (< 7 days) are skipped.
 *
 * This is intentionally async and fire-and-forgetable from the sync endpoint:
 *   fetchAndPersistCollegeHistory(db, ragStmts, apiKey, unitIds).catch(console.warn)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof prepareRAGStatements>} stmts
 * @param {string} apiKey  - SCORECARD_API_KEY
 * @param {string[]} unitIds
 * @returns {Promise<{ fetched: number, skipped: number, errors: number }>}
 */
export async function fetchAndPersistCollegeHistory(db, stmts, apiKey, unitIds) {
  if (!apiKey || !unitIds?.length) return { fetched: 0, skipped: 0, errors: 0 };

  let fetched = 0, skipped = 0, errors = 0;

  for (const unitId of unitIds) {
    if (!unitId) continue;

    // Skip if we have a fresh cache row (< 7 days old)
    const cached = stmts.getScorecardCache?.get(unitId);
    if (cached) { skipped++; continue; }

    const result = await getCollegeHistory(apiKey, unitId, 10);
    if (result.error || !result.history?.length) { errors++; continue; }

    // Persist everything in a single transaction
    try {
      db.transaction(() => {
        // Full-response cache (for quick re-reads without re-fetching)
        stmts.upsertScorecardCache.run(unitId, result.name, JSON.stringify(result));

        // Year-keyed rows for SQL queries and trend assembly
        for (const yr of result.history) {
          stmts.upsertScorecardHistory.run(
            unitId, yr.year, result.name,
            yr.admissionRate, yr.sat25, yr.sat75,
            yr.act25, yr.act75,
            yr.tuitionIn, yr.tuitionOut, yr.avgNetPrice,
            yr.enrollment, yr.gradRate, yr.medianEarnings
          );
        }
      })();
      fetched++;
      console.log(`[SCORECARD] Persisted ${result.history.length} years of history for ${result.name} (${unitId})`);
    } catch (txErr) {
      console.warn(`[SCORECARD] DB write failed for ${unitId}:`, txErr.message);
      errors++;
    }
  }

  return { fetched, skipped, errors };
}

/**
 * Build a college context block for the AI context bundle.
 * For each unitId, assembles latest stats + year-over-year trend summary
 * from the cached `scorecard_history` rows.
 *
 * @param {ReturnType<typeof prepareRAGStatements>} stmts
 * @param {string[]} unitIds
 * @returns {CollegeContextEntry[]}
 */
export function buildCollegeHistoryContext(stmts, unitIds) {
  if (!unitIds?.length) return [];

  return unitIds.map(unitId => {
    const rows = stmts.getScorecardHistory?.all(unitId) || [];
    if (!rows.length) return { unitId, available: false };

    const sorted = [...rows].sort((a, b) => a.year - b.year);
    const latest = sorted[sorted.length - 1];
    const name   = latest.name || unitId;

    // Map DB rows back to the shape summarizeCollegeHistory() expects
    const historyForSummary = sorted.map(r => ({
      year:           r.year,
      admissionRate:  r.admission_rate,
      sat25:          r.sat_25,
      sat75:          r.sat_75,
      act25:          r.act_25,
      act75:          r.act_75,
      tuitionIn:      r.tuition_in,
      tuitionOut:     r.tuition_out,
      avgNetPrice:    r.avg_net_price,
      enrollment:     r.enrollment,
      gradRate:       r.grad_rate,
      medianEarnings: r.median_earnings,
    }));

    return {
      unitId,
      name,
      available: true,
      latestYear: latest.year,
      latest: {
        admissionRate:  latest.admission_rate,
        sat25:          latest.sat_25,
        sat75:          latest.sat_75,
        act25:          latest.act_25,
        act75:          latest.act_75,
        tuitionIn:      latest.tuition_in,
        tuitionOut:     latest.tuition_out,
        avgNetPrice:    latest.avg_net_price,
        enrollment:     latest.enrollment,
        gradRate:       latest.grad_rate,
        medianEarnings: latest.median_earnings,
      },
      // Full year series (oldest-first) for LLM trend reasoning
      yearSeries: historyForSummary,
      // Compact human-readable trend summary (~80 tokens)
      trendSummary: summarizeCollegeHistory(name, historyForSummary),
    };
  }).filter(Boolean);
}

/**
 * Extract unit IDs from a goals array of mixed shape:
 *   [ "MIT", { name: "Stanford", unitId: "243744" }, { id: "166683" }, ... ]
 * Only objects with a numeric-string unitId or id are returned.
 */
export function extractGoalUnitIds(goals) {
  if (!Array.isArray(goals)) return [];
  const ids = [];
  for (const g of goals) {
    if (!g || typeof g !== "object") continue;
    const raw = g.unitId ?? g.unit_id ?? g.id ?? null;
    if (raw && /^\d{6,7}$/.test(String(raw))) ids.push(String(raw));
  }
  return [...new Set(ids)];
}


// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// STUDENT SYNC + CHANGE DETECTION
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
export function syncStudentData(stmts, studentId, profile, activities, goals, majorInterest, trigger = "user_update") {
  const prev = stmts.getLatestSnapshot.get(studentId);
  const changes = detectChanges(prev, profile, activities, majorInterest);
  const academicYear = getAcademicYear();

  const snapshotId = crypto.randomUUID();
  stmts.insertSnapshot.run(
    snapshotId, studentId, changes.length > 0 ? "update" : "sync",
    profile?.gpa?.unweighted ?? null,
    profile?.gpa?.weighted ?? null,
    JSON.stringify(profile?.courses || []),
    JSON.stringify(profile?.apScores || []),
    JSON.stringify(profile?.testScores || []),
    JSON.stringify(activities || []),
    majorInterest || null,
    JSON.stringify(goals || []),
    trigger
  );
  const classRank = normalizeClassRank(profile?.classRank);
  if (stmts.setSnapshotClassRank) stmts.setSnapshotClassRank.run(classRank ? JSON.stringify(classRank) : null, snapshotId);

  for (const change of changes) {
    stmts.insertMilestone.run(
      crypto.randomUUID(), studentId, change.type, change.title,
      JSON.stringify(change.data), academicYear
    );
  }

  recomputeCapabilities(stmts, studentId, profile, activities);

  // Recompute EC strength vectors on every profile update.
  // Per policy: whenever a student edits any EC, the unified strength
  // vector is refreshed and legacy compatibility views are projected
  // from that canonical result.
  // Recompute the unified EC strength vectors. Legacy EC vector surfaces
  // are compatibility projections from this canonical table.
  // the 5-factor recompute so both systems see the same inputs. Errors
  // are logged but never fail the sync (match the resilience pattern
  // above). Awaiting isn't practical here because syncStudentData is
  // synchronous ??we fire-and-track, and the next sync or an explicit
  // POST /api/ec/strength/recompute will pick up any failure.
  let ecStrengthRecomputePromise = null;
  try {
    if (stmts.strength && stmts.narrative) {
      const active = getActiveNarrative(stmts.narrative, studentId);
      const llmClient = stmts.narrativeFitCache
        ? buildDefaultLLMClient(stmts.narrativeFitCache)
        : null;
      ecStrengthRecomputePromise = recomputeStudentECStrengthVectors(
        stmts.strength, studentId,
        {
          activities: activities || [],
          narrative: active?.narrativeText || null,
          narrativeThemes: active?.themes || [],
          narrativeHash: active?.hash || null,
          narrativeId: active?.id || null,
          majorInterest: majorInterest || null,
          llmClient,
          ragStmts: stmts,
        },
      ).catch((err) => {
        console.error("[RAG] EC strength recompute failed:", err);
        return { count: 0, vectors: [] };
      });
    }
  } catch (err) {
    console.error("[RAG] EC strength recompute setup failed:", err);
  }

  // Recompute student directionality (overall academic trajectory).
  let dirRecompute = null;
  try {
    if (stmts.directionality) {
      const currentSnapshot = stmts.getLatestSnapshot.get(studentId);
      const snapshotHistory = stmts.getSnapshotHistory.all(studentId, 2) || [];
      const priorSnapshot = snapshotHistory.length > 1 ? snapshotHistory[1] : null;
      const allSnapshots = stmts.getSnapshotHistory.all(studentId, 10) || [];
      const gpaBaselines = stmts.getGPABaseline.all("t20_admitted") || [];
      const satBaselines = stmts.getSATBaseline.all("t20_admitted") || [];
      const actBaselines = stmts.getACTBaseline.all("t20_admitted") || [];
      const collegeProfiles = stmts.searchColleges.all() || [];

      dirRecompute = recomputeStudentDirectionality(
        stmts.directionality, studentId, currentSnapshot, priorSnapshot,
        allSnapshots, gpaBaselines, satBaselines, actBaselines, collegeProfiles
      );
    }
  } catch (err) {
    console.error("[RAG] Directionality vector recompute failed:", err);
  }

  return {
    synced: true,
    changesDetected: changes.length,
    changes,
    ecVectors: {
      count: Array.isArray(activities) ? activities.filter((a) => a?.name).length : 0,
      recomputedAt: new Date().toISOString(),
      sourceSystem: "ec_strength_vectors",
    },
    directionality: dirRecompute ? {
      id: dirRecompute.id,
      factors: dirRecompute.factors,
      label: dirRecompute.label,
      recomputedAt: dirRecompute.computedAt,
    } : null,
  };
}

function detectChanges(prevSnapshot, profile, activities, majorInterest) {
  const changes = [];
  if (!prevSnapshot) {
    changes.push({ type: "profile_created", title: "Profile created", data: {}, significant: true });
    return changes;
  }

  // GPA change
  const prevGpa = prevSnapshot.gpa_unweighted;
  const newGpa = profile?.gpa?.unweighted;
  if (prevGpa != null && newGpa != null && Math.abs(newGpa - prevGpa) >= 0.05) {
    const direction = newGpa > prevGpa ? "improved" : "changed";
    changes.push({
      type: "gpa_change", significant: true,
      title: `GPA ${direction}: ${prevGpa.toFixed(2)} ??${newGpa.toFixed(2)}`,
      data: { previous: prevGpa, current: newGpa, delta: +(newGpa - prevGpa).toFixed(2) }
    });
  } else if (prevGpa == null && newGpa != null) {
    changes.push({ type: "gpa_set", significant: true, title: `GPA recorded: ${newGpa.toFixed(2)}`, data: { value: newGpa } });
  }

  // Test score changes
  const prevTests = safeParseJSON(prevSnapshot.test_scores_json, []);
  const newTests = profile?.testScores || [];
  for (const nt of newTests) {
    const existing = prevTests.find(pt => pt.test === nt.test && pt.subject === nt.subject);
    if (!existing) {
      changes.push({
        type: "test_score_added", significant: true,
        title: `${(nt.test || "").toUpperCase()}${nt.subject ? ` ${nt.subject}` : ""}: ${nt.totalScore}`,
        data: nt
      });
    } else if (existing.totalScore !== nt.totalScore) {
      changes.push({
        type: "test_score_updated", significant: true,
        title: `${(nt.test || "").toUpperCase()} updated: ${existing.totalScore} ??${nt.totalScore}`,
        data: { previous: existing.totalScore, current: nt.totalScore, test: nt.test }
      });
    }
  }

  // AP score changes
  const prevAP = safeParseJSON(prevSnapshot.ap_scores_json, []);
  const newAP = profile?.apScores || [];
  for (const na of newAP) {
    if (!prevAP.some(pa => pa.exam === na.exam && pa.year === na.year)) {
      changes.push({
        type: "ap_score_added", significant: true,
        title: `AP ${na.exam}: Score ${na.score} (${na.year})`,
        data: na
      });
    }
  }

  // EC changes
  const prevECs = safeParseJSON(prevSnapshot.activities_json, []);
  const newECs = activities || [];
  for (const ne of newECs) {
    const existing = prevECs.find(pe => pe.name === ne.name);
    if (!existing) {
      changes.push({
        type: "ec_added", significant: true,
        title: `New activity: ${ne.name} (${ne.role || ne.category})`,
        data: ne
      });
    } else {
      const leadershipRoles = ["president", "founder", "captain", "head", "director", "lead", "chief", "editor", "chair"];
      const wasLeader = leadershipRoles.some(r => (existing.role || "").toLowerCase().includes(r));
      const isLeader = leadershipRoles.some(r => (ne.role || "").toLowerCase().includes(r));
      if (!wasLeader && isLeader) {
        changes.push({
          type: "ec_leadership", significant: true,
          title: `Leadership promotion: ${ne.name} ??${ne.role}`,
          data: { activity: ne.name, previousRole: existing.role, newRole: ne.role }
        });
      }
    }
  }

  // Course changes (additions + grade/type updates). Courses drive the
  // major-aligned narrative + course recommender, so adding one is a
  // first-class event that should refresh an auto-generated narrative.
  const prevCourses = safeParseJSON(prevSnapshot.courses_json, []);
  const newCourses = profile?.courses || [];
  const courseKey = (c) => String(c?.name || c?.title || "").trim().toLowerCase();
  for (const nc of newCourses) {
    const key = courseKey(nc);
    if (!key) continue;
    const existing = prevCourses.find((pc) => courseKey(pc) === key);
    if (!existing) {
      changes.push({
        type: "course_added", significant: true,
        title: `New course: ${nc.name || nc.title}${nc.type ? ` [${nc.type}]` : ""}`,
        data: nc,
      });
    } else if ((existing.grade || existing.grade_earned) !== (nc.grade || nc.grade_earned) || (existing.type || existing.level) !== (nc.type || nc.level)) {
      changes.push({
        type: "course_updated", significant: false,
        title: `Course updated: ${nc.name || nc.title}`,
        data: { name: nc.name || nc.title, previous: existing, current: nc },
      });
    }
  }

  // Major interest change
  const prevMajor = prevSnapshot.major_interest;
  if (majorInterest && prevMajor && majorInterest !== prevMajor) {
    changes.push({
      type: "major_changed", significant: true,
      title: `Major interest changed: ${prevMajor} ??${majorInterest}`,
      data: { previous: prevMajor, current: majorInterest }
    });
  }

  return changes;
}


// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// CAPABILITY COMPUTATION ??delegates to rules-engine.js
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
function recomputeCapabilities(stmts, studentId, profile, activities) {
  const metrics = [];

  // GPA percentile (delegated to rules-engine.js computePercentile)
  if (profile?.gpa?.unweighted) {
    const natl = computePercentile(stmts.getGPABaseline.all("national"), profile.gpa.unweighted, "gpa_unweighted");
    const cohort = computePercentile(stmts.getGPABaseline.all("college_bound"), profile.gpa.unweighted, "gpa_unweighted");
    metrics.push({ metric: "gpa_uw", value: profile.gpa.unweighted, pNat: natl, pCoh: cohort });
  }
  if (profile?.gpa?.weighted) {
    const natl = computePercentile(stmts.getGPABaseline.all("national"), profile.gpa.weighted, "gpa_weighted");
    const cohort = computePercentile(stmts.getGPABaseline.all("college_bound"), profile.gpa.weighted, "gpa_weighted");
    metrics.push({ metric: "gpa_w", value: profile.gpa.weighted, pNat: natl, pCoh: cohort });
  }

  // SAT percentile
  const satScore = (profile?.testScores || []).find(t => t.test === "sat");
  if (satScore?.totalScore) {
    const natl = computePercentile(stmts.getSATBaseline.all("national"), satScore.totalScore, "score");
    const cohort = computePercentile(stmts.getSATBaseline.all("college_bound"), satScore.totalScore, "score");
    metrics.push({ metric: "sat_total", value: satScore.totalScore, pNat: natl, pCoh: cohort });
  }

  // ACT percentile
  const actScore = (profile?.testScores || []).find(t => t.test === "act");
  if (actScore?.totalScore) {
    const natl = computePercentile(stmts.getACTBaseline.all("national"), actScore.totalScore, "score");
    metrics.push({ metric: "act_total", value: actScore.totalScore, pNat: natl, pCoh: null });
  }

  // EC count
  const ecCount = (activities || []).length;
  metrics.push({ metric: "ec_count", value: ecCount, pNat: null, pCoh: null });

  // AP rigor index (delegated to rules-engine.js computeAPRigorIndex)
  const courses = profile?.courses || [];
  const apResult = computeAPRigorIndex(courses, null);
  if (apResult.index > 0) {
    metrics.push({ metric: "ap_rigor_index", value: apResult.index, pNat: null, pCoh: null });
  }

  for (const m of metrics) {
    stmts.insertCapability.run(crypto.randomUUID(), studentId, m.metric, m.value, m.pNat, m.pCoh);
  }
}


// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// RAG CONTEXT ASSEMBLY ??small-context, PII-free
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// Returns a structured summary (100-200 tokens for model context)
// instead of raw data dumps. Student identity is [STUDENT].

export function assembleRAGContext(stmts, studentId, queryFocus, options = {}) {
  const latestSnap = stmts.getLatestSnapshot.get(studentId);
  if (!latestSnap) return { error: "No profile data", studentContext: null, baselineContext: null };

  // Only latest snapshot by default
  const includeTrends = options.includeTrends || false;
  const capabilities = stmts.getLatestCapabilities.all(studentId);
  const structuredData = getDirectStructuredStudentData(stmts, studentId, {
    snapshot: latestSnap,
    capabilities,
  });

  const studentContext = buildStudentSummary(latestSnap, capabilities, includeTrends ? stmts : null, studentId);
  studentContext.structuredData = structuredData;

  // Attach numeric/categorical vectors ??closes the EC+AP+GPA integration
  // gap. All values here are scores or tiers (no raw activity names, no
  // PII). EC names go through a lightweight screening pass before
  // inclusion.
  try {
    studentContext.vectors = buildVectorsBlock(stmts, studentId);
  } catch (err) {
    console.error("[RAG] vectors assembly failed:", err);
    studentContext.vectors = null;
  }

  // Fold top-3 EC tier labels into the compact text summary so downstream
  // prompts can reason about distinctive ECs without additional retrieval.
  if (studentContext.vectors?.ec_strength?.length) {
    const topTiers = studentContext.vectors.ec_strength
      .slice(0, 3)
      .map((v) => v.tierLabel)
      .filter(Boolean);
    if (topTiers.length > 0) {
      studentContext.textSummary = (studentContext.textSummary || "")
        + ` | Top EC tiers: ${topTiers.join(", ")}`;
    }
  }

  // Small-context baseline: only what's relevant to the query
  const baselineContext = assembleBaselineForQuery(stmts, queryFocus, studentContext);

  // Comparisons
  const comparisons = buildComparisons(capabilities);

  // ?? College history context ?????????????????????????????????????????????
  // Pull cached Scorecard history rows for each goal school that has a
  // known unitId. This is read-only ??the background fetch is triggered
  // separately (on sync or on explicit /api/colleges/history/:id call).
  let collegeContext = null;
  try {
    const goals      = safeParseJSON(latestSnap.goals_json, []);
    const goalIds    = extractGoalUnitIds(goals);
    if (goalIds.length > 0 && stmts.getScorecardHistory) {
      const entries = buildCollegeHistoryContext(stmts, goalIds);
      if (entries.length > 0) {
        collegeContext = {
          goalSchools: entries,
          source: "U.S. Department of Education College Scorecard API",
          note: "Historical data (up to 10 years). Admission-rate trend shows selectivity direction.",
        };
      }
    }
  } catch (err) {
    console.warn("[RAG] College history context failed:", err.message);
  }

  return {
    studentContext,
    baselineContext,
    comparisons,
    collegeContext,
    retrievedAt: new Date().toISOString(),
  };
}

// Assemble the numeric vectors block ??no PII, just scores + tiers.
// EC names are screened and replaced with `activity_N` for any token
// that resembles a personal name (all-cap initials, honorifics). This
// is intentionally conservative ??the point is the tier/factor shape,
// not the EC label.
function buildVectorsBlock(stmts, studentId) {
  const out = { ec_strength: [], ap_subjects: [], directionality: null };

  if (stmts.strength?.getByStudent) {
    const rows = stmts.strength.getByStudent.all(studentId) || [];
    out.ec_strength = rows.map((r, idx) => {
      const shape = toStrengthPublicShape(r);
      if (!shape) return null;
      shape.ecName = screenECName(shape.ecName, idx);
      return shape;
    }).filter(Boolean);
  }

  if (stmts.apConcepts?.getAllSubjectVectors) {
    try {
      out.ap_subjects = stmts.apConcepts.getAllSubjectVectors.all(studentId) || [];
    } catch { /* getAllSubjectVectors is optional */ }
  }

  if (stmts.directionality?.getByStudent) {
    try {
      out.directionality = stmts.directionality.getByStudent.get(studentId) || null;
    } catch { /* stmt signature may differ across versions */ }
  }

  return out;
}

// Structured academic metrics come straight from the relational DB:
// profile_snapshots for raw student-entered values and capability_timeline
// for precomputed percentiles. This path intentionally bypasses vector /
// unstructured retrieval.
export function getDirectStructuredStudentData(stmts, studentId, options = {}) {
  const snapshot = options.snapshot || stmts.getLatestSnapshot?.get(studentId);
  if (!snapshot) return null;

  const capabilities = Array.isArray(options.capabilities)
    ? options.capabilities
    : (stmts.getLatestCapabilities?.all(studentId) || []);

  const courses = safeParseJSON(snapshot.courses_json, []);
  const apScores = safeParseJSON(snapshot.ap_scores_json, []);
  const testScores = safeParseJSON(snapshot.test_scores_json, []);
  const activities = safeParseJSON(snapshot.activities_json, []);

  const sat = testScores.find((t) => String(t?.test || "").toLowerCase() === "sat");
  const act = testScores.find((t) => String(t?.test || "").toLowerCase() === "act");
  const apCourses = courses.filter((c) => {
    const type = String(c?.type || c?.level || "").toLowerCase();
    return type === "ap" || /^ap\b/i.test(String(c?.name || ""));
  });
  const apAverage = apScores.length > 0
    ? Math.round(
      (apScores.reduce((sum, exam) => sum + (Number(exam?.score) || 0), 0) / apScores.length) * 10,
    ) / 10
    : null;

  const metrics = {};
  for (const row of capabilities) {
    if (!row?.metric) continue;
    metrics[row.metric] = {
      value: Number.isFinite(Number(row.value)) ? Number(row.value) : null,
      percentileNational: Number.isFinite(Number(row.percentile_national))
        ? Number(row.percentile_national)
        : null,
      percentileCohort: Number.isFinite(Number(row.percentile_cohort))
        ? Number(row.percentile_cohort)
        : null,
      computedAt: row.computed_at || null,
    };
  }

  return {
    retrieval: "direct_db",
    sourceTables: [
      "profile_snapshots",
      "capability_timeline",
      "baseline_gpa",
      "baseline_sat",
      "baseline_act",
    ],
    snapshotCreatedAt: snapshot.created_at || null,
    profile: {
      gpaUnweighted: Number.isFinite(Number(snapshot.gpa_unweighted)) ? Number(snapshot.gpa_unweighted) : null,
      gpaWeighted: Number.isFinite(Number(snapshot.gpa_weighted)) ? Number(snapshot.gpa_weighted) : null,
      satTotal: Number.isFinite(Number(sat?.totalScore)) ? Number(sat.totalScore) : null,
      actComposite: Number.isFinite(Number(act?.totalScore)) ? Number(act.totalScore) : null,
      courseCount: courses.length,
      apCourseCount: apCourses.length,
      apExamCount: apScores.length,
      apAverageScore: apAverage,
      activitiesCount: activities.length,
      majorInterest: snapshot.major_interest || null,
    },
    metrics,
  };
}

// Replace probable personal-name tokens inside an EC label. Conservative:
// (1) initials like "J. Smith", (2) honorifics ("Mr.", "Ms.", "Dr."),
// (3) double-initials like "J.P. Morgan". When any of those patterns fire,
// we fall back to a positional token so prompts never see a name.
function screenECName(name, idx) {
  const s = String(name || "").trim();
  if (!s) return `activity_${idx + 1}`;
  const looksLikeName =
    /\b(Mr|Mrs|Ms|Dr|Prof)\.?\b/i.test(s)
    || /\b[A-Z]\.\s?[A-Z][a-z]+/.test(s)
    || /\b[A-Z]\.[A-Z]\./.test(s);
  return looksLikeName ? `activity_${idx + 1}` : s;
}

// Build a structured student summary ??NO PII, NO raw dumps
function buildStudentSummary(snapshot, capabilities, stmts, studentId) {
  const profile = {
    gpa: { unweighted: snapshot.gpa_unweighted, weighted: snapshot.gpa_weighted },
    courses: safeParseJSON(snapshot.courses_json, []),
    apScores: safeParseJSON(snapshot.ap_scores_json, []),
    testScores: safeParseJSON(snapshot.test_scores_json, []),
    activities: safeParseJSON(snapshot.activities_json, []),
    goals: safeParseJSON(snapshot.goals_json, []),
  };

  const summary = {
    currentProfile: profile,
    majorInterest: snapshot.major_interest,
    metrics: capabilities.map(c => ({
      metric: c.metric, value: c.value,
      percentileNational: c.percentile_national,
      percentileCohort: c.percentile_cohort,
    })),
    // Compact text summary for model context (keeps token count low)
    textSummary: buildTextSummary(profile, capabilities, snapshot.major_interest),
  };

  // Only include trend data if explicitly requested
  if (stmts && studentId) {
    summary.trends = {};
    for (const metric of ["gpa_uw", "sat_total"]) {
      const data = stmts.getCapabilityTrend.all(studentId, metric);
      if (data.length >= 2) {
        const latest = data[data.length - 1];
        const previous = data[data.length - 2];
        summary.trends[metric] = {
          current: latest.value,
          previous: previous.value,
          direction: latest.value > previous.value ? "improving" : latest.value < previous.value ? "declining" : "stable",
        };
      }
    }
  }

  return summary;
}

// Generate compact text for model context (100-200 tokens)
function buildTextSummary(profile, capabilities, majorInterest) {
  const parts = [];

  if (profile.gpa?.unweighted) parts.push(`GPA: ${profile.gpa.unweighted}`);

  const sat = profile.testScores?.find(t => t.test === "sat");
  if (sat?.totalScore) parts.push(`SAT: ${sat.totalScore}`);

  const act = profile.testScores?.find(t => t.test === "act");
  if (act?.totalScore) parts.push(`ACT: ${act.totalScore}`);

  const apCount = (profile.courses || []).filter(c => c.type === "ap").length;
  if (apCount > 0) parts.push(`AP courses: ${apCount}`);

  const apScoreCount = (profile.apScores || []).length;
  if (apScoreCount > 0) {
    const avgScore = profile.apScores.reduce((sum, a) => sum + (a.score || 0), 0) / apScoreCount;
    parts.push(`AP scores: ${apScoreCount} exams (avg ${avgScore.toFixed(1)})`);
  }

  const ecCount = (profile.activities || []).length;
  if (ecCount > 0) parts.push(`Activities: ${ecCount}`);

  if (majorInterest) parts.push(`Major interest: ${majorInterest}`);

  // Add percentile context
  for (const cap of capabilities) {
    if (cap.percentile_national != null) {
      parts.push(`${cap.metric} percentile: ${cap.percentile_national}th nationally`);
    }
  }

  return parts.join(" | ");
}


// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// BASELINE ASSEMBLY ??query-focused, small context
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
function assembleBaselineForQuery(stmts, focus, studentCtx) {
  const baseline = {
    source: "NCES IPEDS, CollegeBoard, ACT.org, NACAC",
    retrieval: "direct_db",
    sourceTables: ["baseline_gpa", "baseline_sat", "baseline_act", "baseline_ec", "baseline_colleges"],
  };

  // Always include GPA baselines (compact)
  baseline.gpaDistributions = {
    national: stmts.getGPABaseline.all("national"),
    collegeBound: stmts.getGPABaseline.all("college_bound"),
  };

  if (focus === "academics" || focus === "holistic") {
    baseline.satDistributions = {
      national: stmts.getSATBaseline.all("national"),
      collegeBound: stmts.getSATBaseline.all("college_bound"),
    };
    baseline.actDistributions = {
      national: stmts.getACTBaseline.all("national"),
    };
  }

  if (focus === "extracurriculars" || focus === "holistic") {
    const major = studentCtx?.majorInterest || "General";
    baseline.ecBenchmarks = stmts.getECBaseline.all(major);
  }

  if (focus === "college_fit" || focus === "holistic") {
    // Only top-level stats, not full profiles ??keep context small
    baseline.collegeProfiles = stmts.searchColleges.all().map(c => ({
      unitId: c.unit_id, name: c.name, state: c.state,
      sat25: c.sat_25, sat75: c.sat_75,
      acceptance: c.acceptance_rate,
      avgGpaAdmitted: c.avg_gpa_admitted,
      topMajors: safeParseJSON(c.top_majors_json, []),
    }));
  }

  if (focus === "strategy") {
    baseline.satDistributions = { national: stmts.getSATBaseline.all("national") };
    const major = studentCtx?.majorInterest || "General";
    baseline.ecBenchmarks = stmts.getECBaseline.all(major);
  }

  return baseline;
}

function buildComparisons(capabilities) {
  return capabilities.map(cap => {
    const comp = { metric: cap.metric, value: cap.value };
    if (cap.percentile_national != null) {
      comp.vsNational = { percentile: cap.percentile_national, interpretation: interpretPercentile(cap.percentile_national) };
    }
    if (cap.percentile_cohort != null) {
      comp.vsCollegeBound = { percentile: cap.percentile_cohort, interpretation: interpretPercentile(cap.percentile_cohort) };
    }
    return comp;
  });
}

function interpretPercentile(p) {
  if (p >= 95) return "Exceptional ??top 5% nationally";
  if (p >= 90) return "Excellent ??top 10%";
  if (p >= 75) return "Above average ??top 25%";
  if (p >= 50) return "At or above the median";
  if (p >= 25) return "Below median ??room for improvement";
  return "Below average ??focus on strengthening this area";
}


// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// TREND ANALYSIS
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
export function getStudentTrends(stmts, studentId) {
  const trends = {};
  for (const metric of ["gpa_uw", "gpa_w", "sat_total", "act_total", "ec_count", "ap_rigor_index"]) {
    const data = stmts.getCapabilityTrend.all(studentId, metric);
    if (data.length > 0) {
      trends[metric] = {
        current: data[data.length - 1].value,
        history: data.map(d => ({ value: d.value, percentile: d.percentile_national, date: d.computed_at })),
        dataPoints: data.length,
        direction: data.length >= 2
          ? data[data.length - 1].value > data[data.length - 2].value ? "improving"
            : data[data.length - 1].value < data[data.length - 2].value ? "declining" : "stable"
          : "insufficient_data"
      };
    }
  }

  return { studentId, trends, computedAt: new Date().toISOString() };
}


// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// COLLEGE FIT SCORING ??enhanced with baseline data
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
export function enhancedCollegeMatch(stmts, studentId, filters) {
  const snap = stmts.getLatestSnapshot.get(studentId);
  if (!snap) return { error: "No profile data", results: [] };

  const testScores = safeParseJSON(snap.test_scores_json, []);
  const satEntry = testScores.find(t => t.test === "sat");
  const actEntry = testScores.find(t => t.test === "act");
  const sat = satEntry?.totalScore || (actEntry ? actToSat(actEntry.totalScore) : null);
  const gpa = snap.gpa_unweighted;
  const apCourses = safeParseJSON(snap.courses_json, []).filter(c => c.type === "ap");
  const activities = safeParseJSON(snap.activities_json, []);
  const major = snap.major_interest || filters?.majorKeyword;

  // Jiyeon UX audit F4 ??the narrative was never weighted into college fit.
  // If we have an active narrative, pull its majorBuckets + themes and use
  // them as a 4th signal alongside SAT / GPA / AP / EC. This is what makes
  // "MIT for computational biology" actually outscore "MIT for anything"
  // in a student whose narrative is about genomic research.
  let narrativeMajorBuckets = [];
  let narrativeThemes = [];
  try {
    const active = getActiveNarrative(stmts.narrative, studentId);
    if (active) {
      narrativeMajorBuckets = (active.majorBuckets || []).map(String);
      narrativeThemes = (active.themes || [])
        .map((t) => (typeof t === "string" ? t : t?.theme))
        .filter(Boolean)
        .map((t) => t.toLowerCase());
    }
  } catch {
    narrativeMajorBuckets = [];
    narrativeThemes = [];
  }

  let colleges = stmts.searchColleges.all();

  // Apply filters
  if (filters?.states?.length) colleges = colleges.filter(c => filters.states.includes(c.state));
  if (filters?.maxTuition) colleges = colleges.filter(c => c.tuition_in <= filters.maxTuition || c.tuition_out <= filters.maxTuition);
  if (filters?.majorKeyword) {
    const kw = filters.majorKeyword.toLowerCase();
    colleges = colleges.filter(c => {
      const majors = safeParseJSON(c.top_majors_json, []);
      return majors.some(m => m.toLowerCase().includes(kw));
    });
  }

  const results = colleges.map(c => {
    const scores = {};

    // SAT fit (0-100)
    if (sat) {
      const mid = (c.sat_25 + c.sat_75) / 2;
      scores.satFit = Math.max(0, Math.round(100 - Math.abs(sat - mid) / 5));
      scores.satPosition = sat >= c.sat_75 ? "above_75th" : sat >= c.sat_25 ? "within_range" : "below_25th";
    }

    // GPA fit (0-100)
    if (gpa && c.avg_gpa_admitted) {
      const diff = gpa - c.avg_gpa_admitted;
      scores.gpaFit = Math.max(0, Math.round(100 - Math.abs(diff) * 50));
      scores.gpaPosition = diff >= 0.1 ? "above_avg" : diff >= -0.1 ? "at_avg" : "below_avg";
    }

    // AP alignment (0-100)
    const apValued = safeParseJSON(c.ap_courses_valued_json, []);
    if (apCourses.length > 0 && apValued.length > 0) {
      const matching = apCourses.filter(ac => apValued.some(av => ac.name && ac.name.includes(av)));
      scores.apAlignment = Math.round((matching.length / Math.max(apValued.length, 1)) * 100);
    }

    // EC alignment (0-100)
    const ecEmphasis = safeParseJSON(c.ec_emphasis_json, []);
    if (activities.length > 0 && ecEmphasis.length > 0) {
      const matching = activities.filter(a =>
        ecEmphasis.some(em => (a.name || "").toLowerCase().includes(em.toLowerCase().split(/[\s/]/)[0]))
      );
      scores.ecAlignment = Math.round((matching.length / Math.max(3, activities.length)) * 100);
    }

    // Narrative alignment (0-100). Two signals:
    //   1. Major bucket match ??does any of the student's detected major
    //      buckets (from narrative_store) appear in this college's top_majors?
    //      Worth up to 70 points.
    //   2. Theme co-occurrence ??do the student's written themes appear in
    //      the college's top_majors list (loose substring match)?
    //      Worth up to 30 points.
    // If the student has no narrative, we leave narrativeFit undefined so
    // the composite falls back to the legacy weights. F4 from UX audit.
    if (narrativeMajorBuckets.length > 0 || narrativeThemes.length > 0) {
      const topMajorsLower = safeParseJSON(c.top_majors_json, []).map((m) => String(m).toLowerCase());
      let bucketHit = false;
      for (const bucket of narrativeMajorBuckets) {
        const bucketNorm = String(bucket).toLowerCase().replace(/_/g, " ");
        if (topMajorsLower.some((m) => m.includes(bucketNorm) || bucketNorm.includes(m))) {
          bucketHit = true;
          break;
        }
      }
      let themeHits = 0;
      for (const theme of narrativeThemes) {
        if (theme.length < 4) continue;
        if (topMajorsLower.some((m) => m.includes(theme))) {
          themeHits += 1;
          if (themeHits >= 3) break;
        }
      }
      const themeScore = Math.min(30, themeHits * 10);
      scores.narrativeFit = (bucketHit ? 70 : 0) + themeScore;
      scores.narrativeHitBucket = bucketHit;
      scores.narrativeHitThemeCount = themeHits;
    }

    // Composite fit score. Keep legacy weights when narrativeFit is absent.
    const weights = scores.narrativeFit != null
      ? { satFit: 0.25, gpaFit: 0.20, apAlignment: 0.15, ecAlignment: 0.20, narrativeFit: 0.20 }
      : { satFit: 0.30, gpaFit: 0.25, apAlignment: 0.20, ecAlignment: 0.25 };
    let totalWeight = 0;
    let weightedSum = 0;
    for (const [key, weight] of Object.entries(weights)) {
      if (scores[key] != null) {
        weightedSum += scores[key] * weight;
        totalWeight += weight;
      }
    }
    const compositeScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 50;

    // Classify reach/match/safety
    const category = compositeScore >= 75 ? "safety" : compositeScore >= 45 ? "match" : "reach";

    return {
      unitId: c.unit_id, name: c.name, state: c.state,
      sat25: c.sat_25, sat75: c.sat_75,
      acceptance: c.acceptance_rate, enrollment: c.enrollment,
      tuitionIn: c.tuition_in, tuitionOut: c.tuition_out,
      avgGpaAdmitted: c.avg_gpa_admitted,
      gradRate: c.grad_rate_6yr, medianEarnings: c.median_earnings_10yr,
      topMajors: safeParseJSON(c.top_majors_json, []),
      fitScores: scores,
      compositeFit: compositeScore,
      category,
      source: "NCES IPEDS + Common Data Sets"
    };
  });

  results.sort((a, b) => b.compositeFit - a.compositeFit);

  return {
    results: results.slice(0, 15),
    studentMetrics: { sat, gpa, apCount: apCourses.length, ecCount: activities.length, major },
    source: "NCES IPEDS, Common Data Set aggregates"
  };
}


// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??// UTILITIES
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧??
function safeParseJSON(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; }
  catch { return fallback; }
}

function getAcademicYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  return month >= 7 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

const ACT_TO_SAT = {36:1590,35:1570,34:1550,33:1520,32:1500,31:1480,30:1450,29:1420,28:1390,27:1360,26:1330,25:1300,24:1260,23:1230,22:1200,21:1160,20:1130,19:1100,18:1060,17:1030,16:990,15:960,14:920,13:880,12:840,11:800,10:760,9:720};
function actToSat(act) {
  const clamped = Math.max(9, Math.min(36, Math.round(act)));
  return ACT_TO_SAT[clamped] || 1000;
}


